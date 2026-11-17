// Stage E7 guest notification — gn-v2 → RESEND PROVIDER EXECUTOR OFFLINE INTEGRATION (C45, migration 0023) against DISPOSABLE local PostgreSQL.
// Real schema 0023 + the accepted lifecycle chain (R → C → W) to a confirmed booking with ONE pristine guest.notify → the gn-v2 opt-in worker with
// the Resend provider executor (lib/notify/resend-notification-executor.js) over a FAKE exchange (the real reviewed exchange is never given a
// network here) → durable completion through booking.complete_guest_notification_resend with ONE typed provider receipt bound to the gn-v2 render.
// TRUST / SHAPE LABELS: synthetic DOC-DERIVED lifecycle world (copied test-locally, verbatim, from test/db/e7-gn-v2-booking-confirmation.test.mjs,
// itself copied from the worker suite); synthetic `.invalid` addresses only (the out-of-scope row uses `.example` and is never sent); the
// "provider" is an in-memory fake exchange returning Resend-SHAPED replies (documented: HTTP 200 + {"id": UUID}); the key is a sentinel; nothing
// here is real delivery or a real provider call. Assertions on wire content compare booleans so a failure never prints a recipient / body.
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

test("P1 EN and ES acceptance through the Resend executor: real schema 0023 + accepted chain → ONE fake POST with the exact wire body / headers / op-content idempotency key → HTTP 200 UUID → succeeded / 1, result 'resend:<uuid>', ONE typed receipt bound to the gn-v2 render; repeated steps (provider and default) send nothing", async () => {
  assert.deepEqual((await migrationStatus(db.owner, { env: "test" })).applied, range(1, TOP));
  assert.ok(TOP >= 23);
  for (const locale of ["en", "es"]) {
    const bk = await confirmedBooking(); const fx = fakeExchange();
    assert.deepEqual([bk.op.state, bk.op.attempts], ["pending", 0]);
    const exp = await expectedV2(bk, locale);
    const r = CLEAN(await pstep(bk, fx, locale));
    assert.deepEqual([r.ok, r.outcome, r.sends, r.template, r.requestVersion, r.locale, r.provider, r.providerReplay, r.release],
      [true, "accepted", 1, "booking_confirmed", "gn-v2", locale, "resend", false, "RELEASED"], locale);
    assert.equal(fx.calls, 1, `${locale}: ONE exchange call`);
    const q = fx.reqs[0];
    assert.deepEqual([q.method, q.host, q.path], ["POST", "api.resend.com", "/emails"]);
    assert.ok(Buffer.from(q.body).equals(Buffer.from(expectedWire(exp), "utf8")), `${locale}: exact wire body for the bound rows (boolean compare)`);
    const key = `mv-gn2-resend-v1/${bk.op.id}/${exp.contentHash}`;
    assert.ok(JSON.stringify(Object.entries(q.headers)) === JSON.stringify([["Authorization", `Bearer ${KEY}`], ["Content-Type", "application/json"], ["Content-Length", String(Buffer.byteLength(expectedWire(exp)))],
      ["User-Agent", RESEND_USER_AGENT], ["Idempotency-Key", key], ["Accept", "application/json"], ["Accept-Encoding", "identity"]]), `${locale}: exact headers + idempotency key`);
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.attempts, op.result_ref, op.error_code, op.lease_worker_id], ["succeeded", 1, `resend:${fx.ids[0]}`, null, null]);
    const rd = await renderOf(bk.op.id);
    assert.deepEqual([rd.template_version, rd.message_ref, rd.locale, rd.copy_contract_version, rd.content_hash], ["gn-v2", `gn2-${bk.op.id}`, locale, "bcc-v1", exp.contentHash]);
    const rc = await receiptOf(bk.op.id);
    assert.deepEqual([rc.provider, rc.protocol, rc.provider_message_id, rc.replayed, rc.idempotency_key, rc.content_hash, rc.intent_id, rc.worker],
      ["resend", "resend-gn2-v1", fx.ids[0], false, key, rd.content_hash, bk.id, "gn2-1"]);
    assert.equal(await casesOf(bk.id), 0);
    const d = await digest(bk);
    for (let k = 0; k < 2; k++) { const fk = fakeExchange(); assert.equal((await pstep(bk, fk, locale, { workerId: `gn2-r${k}` })).outcome, "idle"); assert.equal(fk.calls, 0); }
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, sink(), { workerId: `gn2-v1-${k}` })).outcome, "idle", "the default path never takes a sent row");
    assert.deepEqual(await recover([bk.listingId], null, 10), { processed: 0, skippedLocked: 0, skippedProtected: 0 });
    assert.equal(fx.calls, 1); assert.equal(await digest(bk), d, "repeated steps: no write");
  }
  assert.equal(netAttempts, 0);
});

test("P2 replay is classified honestly: HTTP 200 + idempotent-replayed: true → succeeded with receipt.replayed = true (distinct provenance), ONE exchange call, never a second invocation", async () => {
  const bk = await confirmedBooking();
  const fx = fakeExchange((id) => ({ status: 200, headers: H200({ idempotentReplayed: "true" }), body: Buffer.from(`{"id":"${id}"}`) }));
  const r = CLEAN(await pstep(bk, fx, "es"));
  assert.deepEqual([r.outcome, r.provider, r.providerReplay, fx.calls], ["accepted", "resend", true, 1]);
  assert.equal((await receiptOf(bk.op.id)).replayed, true);
  assert.equal((await pstep(bk, fakeExchange(), "es", { workerId: "gn2-z" })).outcome, "idle");
});

test("P3 every non-acceptance is a fail-closed code-only UNKNOWN with NO resend and NO receipt: 201 / 307 / 409 / 429 / 500, malformed / extra / PII-shaped reply, lost reply, deadline, oversize, unknown throw", async () => {
  const B = (s) => Buffer.from(s);
  const cases = [["201", (id) => ({ status: 201, headers: H200(), body: B(`{"id":"${id}"}`) }), "HTTP_STATUS"], ["307", () => ({ status: 307, headers: H200(), body: B("") }), "HTTP_STATUS"],
    ["409", () => ({ status: 409, headers: H200(), body: B('{"name":"invalid_idempotent_request","message":"SENTINEL"}') }), "HTTP_STATUS"],
    ["429", () => ({ status: 429, headers: H200(), body: B("{}") }), "HTTP_STATUS"], ["500", () => ({ status: 500, headers: H200(), body: B("SENTINEL") }), "HTTP_STATUS"],
    ["malformed", () => ({ status: 200, headers: H200(), body: B("SENTINEL not json") }), "REPLY_JSON_INVALID"],
    ["extra key", (id) => ({ status: 200, headers: H200(), body: B(`{"id":"${id}","object":"email"}`) }), "REPLY_SHAPE"],
    ["PII-shaped", (id) => ({ status: 200, headers: H200(), body: B(`{"id":"${id}","to":"SENTINEL@example.com"}`) }), "REPLY_SHAPE"],
    ["lost reply", () => Promise.reject(Object.assign(new Error(`SENTINEL ${KEY}`), { code: "EXCHANGE_NETWORK_ERROR" })), "EXCHANGE_NETWORK_ERROR"],
    ["deadline", () => Promise.reject(Object.assign(new Error("x"), { code: "EXCHANGE_DEADLINE" })), "EXCHANGE_DEADLINE"],
    ["oversize", () => Promise.reject(Object.assign(new Error("x"), { code: "EXCHANGE_BODY_TOO_LARGE" })), "EXCHANGE_BODY_TOO_LARGE"],
    ["unknown throw", () => Promise.reject(new Error("SENTINEL")), "EXCHANGE_UNKNOWN"]];
  for (const [kind, reply, code] of cases) {
    const bk = await confirmedBooking(); const fx = fakeExchange(reply);
    const r = CLEAN(await pstep(bk, fx, kind.length % 2 ? "en" : "es"));
    assert.deepEqual([r.outcome, r.code, r.sends, fx.calls], ["unknown", code, 1, 1], kind);
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.error_code, op.result_ref, op.attempts], ["outcome_unknown", code, null, 1], kind);
    assert.equal(await receiptOf(bk.op.id), undefined, `${kind}: no receipt`);
    assert.equal(await casesOf(bk.id), 1);
    const fk = fakeExchange(); assert.equal((await pstep(bk, fk, "en", { workerId: "gn2-again" })).outcome, "idle"); assert.equal(fk.calls, 0, `${kind}: never resent`);
  }
});

test("P4 DB / COMMIT uncertainty on the Resend settlement: committed-then-lost → the SAME error, durable succeeded + receipt, no resend; not committed → in_flight, no receipt, never resent", async () => {
  const boom = () => Object.assign(new Error("synthetic connection loss"), { code: "08006" });
  { const bk = await confirmedBooking(); const fx = fakeExchange(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification_resend: async ({ exec }) => { await exec(); throw e; } });
    await assert.rejects(pstep(bk, fx, "en", {}, p), (x) => x === e);
    assert.equal(p.log.at(-1), "pool:complete_guest_notification_resend", "no query after the outer failure");
    assert.deepEqual([(await notifyOf(bk.id)).state, (await receiptOf(bk.op.id))?.provider, fx.calls], ["succeeded", "resend", 1]);
    const fk = fakeExchange(); assert.equal((await pstep(bk, fk, "en", { workerId: "gn2-y" })).outcome, "idle"); assert.equal(fk.calls, 0); }
  { const bk = await confirmedBooking(); const fx = fakeExchange(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification_resend: () => { throw e; } });
    await assert.rejects(pstep(bk, fx, "es", {}, p), (x) => x === e);
    assert.deepEqual([(await notifyOf(bk.id)).state, await receiptOf(bk.op.id), fx.calls], ["in_flight", undefined, 1]);
    const fk = fakeExchange(); assert.equal((await pstep(bk, fk, "es", { workerId: "gn2-x" })).outcome, "idle"); assert.equal(fk.calls, 0); }
});

test("P5 refused BEFORE any exchange: gn-v1 + provider, provider + mock executors, look-alike / spent executor, sender binding mismatch (ZERO queries); failure templates; out-of-scope recipient; pre-send mismatch → not invoked", async () => {
  const bk0 = { id: "00000000-0000-4000-8000-0000000000c5", listingId: 891998 };
  const fx0 = fakeExchange(); const pe = mkPE(fx0);
  const spent = mkPE(fakeExchange()); await spent.send({ request: Object.freeze({}), opId: bk0.id, contentHash: "0".repeat(64) });
  const other = mkPE(fakeExchange(), { fromAddress: "ops@sender.mv-test.invalid", fromName: "maraVilla Test" });
  const bad = [
    ["gn-v1 + provider (no confirmationLocale)", (() => { const o = provOpts(bk0, pe, "en"); delete o[NOTIFICATION_V2_OPTION_KEY]; return o; })()],
    ["provider + mock executors", { ...provOpts(bk0, pe, "en"), executors: { sendMessage: () => {}, label: "mock-x" } }],
    ["look-alike executor", provOpts(bk0, { ...pe }, "en")], ["prototype-derived", provOpts(bk0, Object.create(pe), "es")],
    ["spent executor", provOpts(bk0, spent, "en")], ["sender binding mismatch", provOpts(bk0, other, "en")], ["null", provOpts(bk0, null, "en")]];
  for (const [kind, o] of bad) {
    const p = wrapPool(db.app);
    assert.deepEqual(await runNotificationStep(p, o), { ok: false, code: "OPTIONS_INVALID" }, kind);
    assert.deepEqual(p.log, [], `${kind}: zero queries`);
  }
  assert.equal(fx0.calls, 0);
  for (const mk of [releasedBooking, cancelledBooking]) {
    const bk = await mk(); const fx = fakeExchange();
    const r = await pstep(bk, fx, "en");
    assert.deepEqual([r.outcome, r.code, fx.calls], ["not_claimable", "TEMPLATE_NOT_V2", 0]);
  }
  const out = await confirmedBooking({ guestDomain: "mv-test.example" }); const fo = fakeExchange();
  assert.deepEqual([(await pstep(out, fo, "es")).outcome, fo.calls], ["idle", 0], "out-of-scope recipient never acquired");
  for (const mut of [(s) => { s.contentHash = "f".repeat(64); }, (s) => { s.locale = s.locale === "en" ? "es" : "en"; }, (s) => { s.templateVersion = "gn-v1"; }]) {
    const bk = await confirmedBooking(); const fx = fakeExchange();
    const p = wrapPool(db.app, { guest_notification_presend: async ({ exec }) => { const r = await exec(); mut(r.rows[0].r); return r; } });
    const r = await pstep(bk, fx, "en", {}, p);
    assert.deepEqual([r.outcome, r.code, r.abort, fx.calls], ["unknown", "PRESEND_ABORTED_NOT_INVOKED", "REQUEST_MISMATCH", 0]);
    assert.equal(await receiptOf(bk.op.id), undefined);
  }
});

test("P6 no-await boundary on the provider path: snapshot → v2 claim → pre-send → the ONE exchange right after the pre-send COMMIT / release → the dedicated Resend settlement", async () => {
  const bk = await confirmedBooking(); const fx = fakeExchange();
  const pool = wrapPool(db.app); fx.lastEvent = () => pool.log.at(-1);
  assert.equal((await pstep(bk, fx, "es", {}, pool)).outcome, "accepted");
  assert.deepEqual(pool.log, ["pool:marker", "pool:clock", "pool:recover_expired_notifications", "pool:claim_notification_work",
    "connect", "tx:BEGIN", "tx:guest_notification_snapshot", "tx:COMMIT", "release", "pool:claim_guest_notification_v2",
    "connect", "tx:BEGIN", "tx:guest_notification_presend", "tx:COMMIT", "release", "pool:complete_guest_notification_resend", "pool:release_notification_work"]);
  assert.deepEqual(fx.events, ["release"], "nothing between the pre-send COMMIT / release and the one exchange call");
});

test("P7 SQL fences: a gn-v1 render can never complete with a UUID (dedicated completion refuses; raw owner UPDATE fenced); 0016 completion still mock-only; receipt binding / append-only / ACL; argument guards", async () => {
  const UU = "11111111-2222-4333-8444-555555555555";
  const bk = await confirmedBooking(); const snk = sink(); const notes = [];
  const r = await step(bk, snk, { hooks: { afterClaim: async (op) => {
    const e1 = await pgErr(() => db.app.query("SELECT booking.complete_guest_notification_resend($1, 'gn2-1', 'accepted', $2::uuid, false, NULL) AS r", [op, UU]));
    notes.push(["resend on gn-v1", e1.message.slice(0, 60)]);
    for (const ref of [`resend:${UU}`, UU]) {
      const e2 = await pgErr(() => db.app.query("SELECT booking.complete_guest_notification($1, 'gn2-1', 'accepted', $2, NULL) AS r", [op, ref]));
      notes.push(["0016 with uuid", e2.message.slice(0, 40)]);
    }
    const c = new pg.Client({ connectionString: db.adminUrl }); await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), $1, 'complete')", [op]);
      const e3 = await pgErr(() => c.query("UPDATE booking.external_operations SET state = 'succeeded', result_ref = $2, completed_at = now(), lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op, `resend:${UU}`]));
      notes.push(["raw owner resend ref", e3.message.slice(0, 40)]);
    } finally { await c.query("ROLLBACK").catch(() => {}); await c.end(); }
    notes.push(["still in flight", (await notifyOf(bk.id)).state]);
  } } });
  assert.match(notes[0][1], /^NOTIFY_ARGUMENT_INVALID: a Resend completion needs/);
  assert.match(notes[1][1], /^NOTIFY_ARGUMENT_INVALID/); assert.match(notes[2][1], /^NOTIFY_ARGUMENT_INVALID/);
  assert.match(notes[3][1], /^NOTIFY_COMPLETE_FENCED/);
  assert.deepEqual(notes[4], ["still in flight", "in_flight"]);
  assert.deepEqual([r.outcome, (await notifyOf(bk.id)).result_ref.startsWith("mock-"), await receiptOf(bk.op.id)], ["accepted", true, undefined], "the gn-v1 row completed only with its mock id");
  // receipts: runtime roles cannot write; owner raw inserts must bind to a gn-v2 render + its hash; append-only
  const v2bk = await confirmedBooking(); const fx = fakeExchange(); await pstep(v2bk, fx, "en");
  const rc = await receiptOf(v2bk.op.id);
  assert.equal((await pgErr(() => db.app.query(`INSERT INTO booking.notification_provider_receipts (operation_id, intent_id, provider, protocol, provider_message_id, replayed, idempotency_key, content_hash, worker, recorded_at)
     VALUES ($1::uuid, $2::uuid, 'resend', 'resend-gn2-v1', $3::uuid, false, 'mv-gn2-resend-v1/' || $1::uuid::text || '/' || $4, $4, 'w', now())`, [bk.op.id, bk.id, UU, "a".repeat(64)]))).code, "42501");
  const own = (opId, intentId, hash) => db.owner.query(`INSERT INTO booking.notification_provider_receipts (operation_id, intent_id, provider, protocol, provider_message_id, replayed, idempotency_key, content_hash, worker, recorded_at)
     VALUES ($1::uuid, $2::uuid, 'resend', 'resend-gn2-v1', $3::uuid, false, 'mv-gn2-resend-v1/' || $1::uuid::text || '/' || $4, $4, 'w', now())`, [opId, intentId, UU, hash]);
  const v1hash = (await renderOf(bk.op.id)).content_hash;
  assert.match((await pgErr(() => own(bk.op.id, bk.id, v1hash))).message, /^NOTIFY_RECEIPT_BINDING/, "a gn-v1 render cannot carry a provider receipt");
  assert.match((await pgErr(() => db.owner.query("UPDATE booking.notification_provider_receipts SET replayed = true WHERE operation_id = $1", [v2bk.op.id]))).message, /IMMUTABLE|append|reject|not allowed/i);
  assert.equal((await pgErr(() => db.app.query("DELETE FROM booking.notification_provider_receipts WHERE operation_id = $1", [v2bk.op.id]))).code, "42501");
  assert.deepEqual(await receiptOf(v2bk.op.id), rc, "receipt unchanged");
  // ACL: the same boundary as the 0016 / 0022 notification functions; receipts readable by app / admin only
  const acl = async (sig) => (await one(`SELECT array_to_string(proacl, ',') AS a, prosecdef AS d, array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = '${sig}'::regprocedure`));
  const f = await acl("booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)");
  assert.deepEqual([f.a, f.d, f.c], [(await acl("booking.complete_guest_notification(uuid,text,text,text,text)")).a, true, "search_path=pg_catalog, booking"]);
  assert.equal(f.a, "postgres=X/postgres,mv_booking_app=X/postgres");
  const grants = (await db.owner.query("SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking' AND table_name = 'notification_provider_receipts' AND grantee <> 'postgres' ORDER BY 1, 2")).rows.map((x) => `${x.grantee}:${x.privilege_type}`);
  assert.deepEqual(grants, ["mv_booking_admin:SELECT", "mv_booking_app:SELECT"]);
  // argument guards (no write)
  for (const [kind, args] of [["accepted w/o replayed", [v2bk.op.id, "gn2-1", "accepted", UU, null, null]], ["accepted with code", [v2bk.op.id, "gn2-1", "accepted", UU, false, "HTTP_STATUS"]],
    ["unknown with id", [v2bk.op.id, "gn2-1", "unknown", UU, null, "HTTP_STATUS"]], ["unknown foreign code", [v2bk.op.id, "gn2-1", "unknown", null, null, "SENTINEL"]], ["bad kind", [v2bk.op.id, "gn2-1", "replayed", UU, true, null]]]) {
    assert.match((await pgErr(() => db.app.query("SELECT booking.complete_guest_notification_resend($1, $2, $3, $4::uuid, $5, $6) AS r", args))).message, /^NOTIFY_ARGUMENT_INVALID/, kind);
  }
});

test("P9 C54 exact approved real sender (SENDER ONLY; recipients stay .invalid): real worker + Resend executor over the FAKE exchange on schema 23 → accepted in gn-v2 with the real `from`; sender bound into contentHash; every other path / variant refused with ZERO queries; UNKNOWN never resent", async () => {
  const REAL = Object.freeze({ ...APPROVED_REAL_SENDER });
  assert.deepEqual({ ...REAL }, { fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect" });
  const realOpts = (bk, fx, locale, over = {}) => provOpts(bk, mkPE(fx, REAL), locale, { sender: { ...REAL }, ...over });
  for (const locale of ["en", "es"]) {
    const bk = await confirmedBooking(); const fx = fakeExchange();
    const exp = await expectedV2(bk, locale, REAL); const syn = await expectedV2(bk, locale);
    assert.equal(exp.ok, true); assert.notEqual(exp.contentHash, syn.contentHash, "changing the sender changes the bound contentHash");
    const r = CLEAN(await runNotificationStep(db.app, realOpts(bk, fx, locale)));
    assert.deepEqual([r.ok, r.outcome, r.sends, r.requestVersion, r.locale, r.provider, fx.calls], [true, "accepted", 1, "gn-v2", locale, "resend", 1], locale);
    const wire = JSON.parse(Buffer.from(fx.reqs[0].body).toString("utf8"));
    assert.equal(wire.from, "MiCasaDirect <bookings@mail.micasadirect.com>"); assert.deepEqual(wire.to, [exp.request.to]); assert.match(exp.request.to, /\.invalid$/);
    assert.equal(fx.reqs[0].headers["Idempotency-Key"], `mv-gn2-resend-v1/${bk.op.id}/${exp.contentHash}`);
    assert.equal((await renderOf(bk.op.id)).content_hash, exp.contentHash);
    assert.equal((await receiptOf(bk.op.id)).content_hash, exp.contentHash);
    assert.equal((await notifyOf(bk.id)).state, "succeeded");
    const fk = fakeExchange(); assert.equal((await runNotificationStep(db.app, realOpts(bk, fk, locale, { workerId: "gn2-again" }))).outcome, "idle"); assert.equal(fk.calls, 0, "no resend");
  }
  { const bk = await confirmedBooking(); const fx = fakeExchange(() => ({ status: 500, headers: H200(), body: Buffer.from("x") }));
    const r = CLEAN(await runNotificationStep(db.app, realOpts(bk, fx, "en")));
    assert.deepEqual([r.outcome, r.code, fx.calls, (await notifyOf(bk.id)).state, await receiptOf(bk.op.id)], ["unknown", "HTTP_STATUS", 1, "outcome_unknown", undefined]);
    const fk = fakeExchange(); assert.equal((await runNotificationStep(db.app, realOpts(bk, fk, "en", { workerId: "gn2-u" }))).outcome, "idle"); assert.equal(fk.calls, 0, "UNKNOWN never resent"); }
  const bk0 = { id: "00000000-0000-4000-8000-0000000000c9", listingId: 891999 };
  const fx0 = fakeExchange(); const peReal = mkPE(fx0, REAL); const peSyn = mkPE(fx0);
  const noV2 = (o) => { delete o[NOTIFICATION_V2_OPTION_KEY]; return o; };
  const noPE = (o) => { delete o[NOTIFICATION_PROVIDER_OPTION_KEY]; return o; };
  const acc = { fromName: REAL.fromName }; let getter = 0; Object.defineProperty(acc, "fromAddress", { enumerable: true, get() { getter += 1; return REAL.fromAddress; } });
  const refusedCases = [
    ["real sender through default gn-v1 mock path", gnOpts(bk0, sink(), { sender: { ...REAL } })],
    ["real sender through gn-v2 mock path", gnOpts(bk0, sink(), { sender: { ...REAL }, ...v2("en") })],
    ["real sender, gn-v1 + provider", noV2(provOpts(bk0, peReal, "en", { sender: { ...REAL } }))],
    ["real sender, gn-v2 without provider", noPE(provOpts(bk0, peReal, "en", { sender: { ...REAL } }))],
    ["real sender, provider + mock executors", provOpts(bk0, peReal, "en", { sender: { ...REAL }, executors: { sendMessage: () => {}, label: "mock-x" } })],
    ["real sender, look-alike executor", provOpts(bk0, { ...peReal }, "en", { sender: { ...REAL } })],
    ["real sender, synthetic-bound executor", provOpts(bk0, peSyn, "en", { sender: { ...REAL } })],
    ["synthetic sender, real-bound executor", provOpts(bk0, peReal, "en")],
    ["hidden accessor sender", provOpts(bk0, peReal, "en", { sender: acc })],
    ["superseded maraVilla identity (2026-11-14)", provOpts(bk0, peReal, "en", { sender: { fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla" } })],
    ["sender extra key", provOpts(bk0, peReal, "en", { sender: { ...REAL, replyTo: "a@b.invalid" } })]];
  for (const fromAddress of ["Bookings@mail.micasadirect.com", "bookings@micasadirect.com", "bookings@x.mail.micasadirect.com", "booking@mail.micasadirect.com", "bookings@mail.micasadirect.com."]) {
    refusedCases.push([`variant address ${fromAddress}`, provOpts(bk0, peReal, "en", { sender: { ...REAL, fromAddress } })]);
  }
  for (const fromName of ["micasadirect", "MiCasaDirect Test", "MiCasaDirect ", "maraVilla"]) refusedCases.push([`variant name ${fromName}`, provOpts(bk0, peReal, "en", { sender: { ...REAL, fromName } })]);
  for (const [kind, o] of refusedCases) {
    const p = wrapPool(db.app);
    assert.deepEqual(await runNotificationStep(p, o), { ok: false, code: "OPTIONS_INVALID" }, kind);
    assert.deepEqual(p.log, [], `${kind}: zero queries`);
  }
  assert.equal(getter, 0, "hidden accessor never invoked"); assert.equal(fx0.calls, 0);
  const out = await confirmedBooking({ guestDomain: "mv-test.example" }); const fo = fakeExchange();
  assert.deepEqual([(await runNotificationStep(db.app, realOpts(out, fo, "en"))).outcome, fo.calls], ["idle", 0], "real sender never widens the recipient scope (.example never acquired)");
  assert.equal(netAttempts, 0);
});

test("P10 C116 simulation-sink RECIPIENT (0025): a guest stored as exactly delivered@resend.dev is ELIGIBLE and goes through the UNCHANGED gn-v2 chain with the approved sender over the FAKE exchange — wire `to` == stored guest email == the address bound into the render recipientHash; ONE receipt; repeated steps idle (no resend); UNKNOWN never resent; look-alike guests never acquired; the gn-v1 (mock) path never sends to the sink; the sink is never a sender", async () => {
  assert.ok(TOP >= 25, "0025 applied");
  const REAL = Object.freeze({ ...APPROVED_REAL_SENDER }); const SINK = "delivered@resend.dev";
  const realOpts = (bk, fx, locale, over = {}) => provOpts(bk, mkPE(fx, REAL), locale, { sender: { ...REAL }, ...over });
  { const bk = await confirmedBooking({ guestEmail: SINK }); const fx = fakeExchange();
    const g = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [bk.id]);
    assert.equal(g.email === SINK, true, "stored guest email is exactly the sink");
    assert.equal(await klass(bk.op.id), "ELIGIBLE");
    const exp = await expectedV2(bk, "en", REAL); assert.equal(exp.ok, true);
    const r = CLEAN(await runNotificationStep(db.app, realOpts(bk, fx, "en")));
    assert.deepEqual([r.ok, r.outcome, r.sends, r.requestVersion, r.provider, fx.calls], [true, "accepted", 1, "gn-v2", "resend", 1]);
    const wire = JSON.parse(Buffer.from(fx.reqs[0].body).toString("utf8"));
    assert.equal(JSON.stringify(wire.to) === JSON.stringify([SINK]), true, "wire recipient is exactly the stored sink (no rewrite)");
    assert.equal(exp.request.to === SINK, true);
    const rd = await renderOf(bk.op.id);
    assert.equal(rd.recipient_hash, exp.recipientHash, "render recipientHash is the stored sink + name");
    assert.equal(rd.content_hash, exp.contentHash);
    const rc = await receiptOf(bk.op.id); assert.equal(rc.content_hash, exp.contentHash);
    assert.deepEqual([(await notifyOf(bk.id)).state, (await notifyOf(bk.id)).attempts], ["succeeded", 1]);
    for (let k = 0; k < 2; k++) { const fk = fakeExchange(); assert.equal((await runNotificationStep(db.app, realOpts(bk, fk, "en", { workerId: `gn2-s${k}` }))).outcome, "idle"); assert.equal(fk.calls, 0, "no resend"); } }
  { const bk = await confirmedBooking({ guestEmail: SINK }); const fx = fakeExchange(() => ({ status: 500, headers: H200(), body: Buffer.from("x") }));
    const r = CLEAN(await runNotificationStep(db.app, realOpts(bk, fx, "en")));
    assert.deepEqual([r.outcome, fx.calls, (await notifyOf(bk.id)).state, await receiptOf(bk.op.id)], ["unknown", 1, "outcome_unknown", undefined]);
    const fk = fakeExchange(); assert.equal((await runNotificationStep(db.app, realOpts(bk, fk, "en", { workerId: "gn2-su" }))).outcome, "idle"); assert.equal(fk.calls, 0, "UNKNOWN never resent"); }
  for (const look of ["delivered+x@resend.dev", "x@resend.dev", "delivered@resend.dev.example", "delivered@mail.resend.dev", "delivered@resend.devx"]) {
    const bk = await confirmedBooking({ guestEmail: look }); const fx = fakeExchange();
    assert.notEqual(await klass(bk.op.id), "ELIGIBLE", look);
    assert.deepEqual([(await runNotificationStep(db.app, realOpts(bk, fx, "en"))).outcome, fx.calls], ["idle", 0], `${look}: never acquired`);
  }
  { const bk = await confirmedBooking({ guestEmail: SINK }); const s = sink();
    const r = await step(bk, s, { workerId: "gn1-sink" });
    assert.equal(r.sends ?? 0, 0, "the gn-v1 (mock) path never sends to the sink (its builder keeps the `.invalid`-only recipient rule)");
    assert.equal(s.invocations, 0); }
  const bk0 = { id: "00000000-0000-4000-8000-0000000000ca", listingId: 891998 };
  const fx0 = fakeExchange(); const peSyn = mkPE(fx0);
  for (const sender of [{ fromAddress: SINK, fromName: "MiCasaDirect" }, { fromAddress: SINK, fromName: "maraVilla Test" }]) {
    assert.equal(createResendNotificationExecutor({ exchange: fx0.exchange, credential: () => KEY, sender: { ...sender } }).ok, false, "the sink is never an executor sender");
    for (const o of [provOpts(bk0, peSyn, "en", { sender: { ...sender } }), gnOpts(bk0, sink(), { sender: { ...sender } }), gnOpts(bk0, sink(), { sender: { ...sender }, ...v2("en") })]) {
      const p = wrapPool(db.app);
      assert.deepEqual(await runNotificationStep(p, o), { ok: false, code: "OPTIONS_INVALID" }, "the sink is never a worker sender");
      assert.deepEqual(p.log, [], "zero queries");
    }
  }
  assert.equal(fx0.calls, 0);
  assert.equal(netAttempts, 0);
});

test("P8 migration 0023: refused down while Resend evidence exists (audit + schema unchanged); a separate fresh cluster with only gn-v1 audit: exact 23 → 22 == forward-built 22, re-up identical; a planted receipt then refuses", async () => {
  const schema = async (c) => (await c.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') || '|' ||
             p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(array_to_string(p.proconfig, ','), '') AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || grantee || '|' || table_name || '|' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'booking'
      UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || array_to_string(roles, ',') || '|' || cmd FROM pg_policies WHERE schemaname = 'booking'
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'rls|' || relname || '|' || relrowsecurity::text FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'
      ORDER BY 1`)).rows.map((r) => r.o);
  const history = async (c) => { const st = await migrationStatus(c, { env: "test" }); return [st.applied, st.pending]; };
  const audit = async (c) => (await c.query(`SELECT md5(coalesce((SELECT string_agg(row_to_json(p)::text, '|' ORDER BY p.operation_id) FROM booking.notification_provider_receipts p), '') ||
      coalesce((SELECT string_agg(o.id::text || o.state || coalesce(o.result_ref, ''), '|' ORDER BY o.id) FROM booking.external_operations o WHERE o.op_type = 'guest.notify'), '')) AS d`)).rows[0].d;
  // (1) this suite's database: receipts exist → the 0023 down refuses, nothing changes
  assert.ok(Number((await db.owner.query("SELECT count(*) AS n FROM booking.notification_provider_receipts")).rows[0].n) >= 3);
  const own = new pg.Client({ connectionString: db.adminUrl }); await own.connect();
  try {
    const s0 = await schema(own); const a0 = await audit(own);
    assert.match((await pgErr(() => migrateDown(own, { env: "test", to: 22 }))).message, /^MIGRATION_0023_DOWN_REFUSED/);
    // C107: migrations above 0023 with no evidence of their own here (0024: no claimed kickoff request in this suite's database) roll back
    // mechanically first, each in its own transaction; then 0023 refuses. The exact history is asserted and the top restored (C45 convention).
    assert.deepEqual(await history(own), [range(1, 23), TOP > 23 ? range(24, TOP) : []]);
    assert.equal(await audit(own), a0, "provider evidence byte-equal");
    assert.deepEqual(await migrateUp(own, { env: "test" }), TOP > 23 ? range(24, TOP) : []);
    assert.deepEqual(await history(own), [range(1, TOP), []]); assert.deepEqual(await schema(own), s0);
  } finally { await own.end(); }
  // (2) a separate disposable cluster (only a gn-v1 render, TEST SETUP) vs a forward-built 22
  const m = await startMigratedDatabase(); const f22 = await startPostgres();
  const admin = new pg.Client({ connectionString: m.adminUrl }); await admin.connect();
  const c22 = new pg.Client({ connectionString: f22.adminUrl }); await c22.connect();
  try {
    assert.deepEqual(await migrateUp(c22, { env: "test", to: 22 }), range(1, 22));
    const atTop = await schema(admin);
    const plant = async (ver) => {
      const id = (await createIntentRecord(m.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: Date.now(), listingId: 999023, from: "2027-04-10", to: "2027-04-12", guests: 2 })).id;
      await F.ownerManagedHistory(m.owner, `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, attempts,
         next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), '${id}', 'guest.notify', 'notify:${id}:booking_confirmed', 'idempotent', 'pending', '{"template":"booking_confirmed"}', 0, 5, 0, now(), now(), now())`);
      const op = (await admin.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id])).rows[0].id;
      const H = "c".repeat(64);
      if (ver === "gn-v1") await F.ownerManagedHistory(m.owner, `INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
         content_hash, message_ref, worker, claimed_at) VALUES ($1::uuid, $2::uuid, 'booking_confirmed', 'gn-v1', 0, '{}', $3, $3, $3, 'gn1-' || $1::uuid::text, 'w', now())`, [op, id, H]);
      else {
        await F.ownerManagedHistory(m.owner, `INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
           content_hash, message_ref, worker, claimed_at, locale, copy_contract_version) VALUES ($1::uuid, $2::uuid, 'booking_confirmed', 'gn-v2', 0, '{}', $3, $3, $3, 'gn2-' || $1::uuid::text, 'w', now(), 'es', 'bcc-v1')`, [op, id, H]);
        await admin.query(`INSERT INTO booking.notification_provider_receipts (operation_id, intent_id, provider, protocol, provider_message_id, replayed, idempotency_key, content_hash, worker, recorded_at)
           VALUES ($1::uuid, $2::uuid, 'resend', 'resend-gn2-v1', gen_random_uuid(), false, 'mv-gn2-resend-v1/' || $1::uuid::text || '/' || $3, $3, 'w', now())`, [op, id, H]);
      }
    };
    await plant("gn-v1");
    const v1 = async () => (await admin.query("SELECT md5(string_agg(row_to_json(r)::text, '|')) AS d FROM booking.notification_renders r")).rows[0].d;
    const r0 = await v1();
    assert.deepEqual(await migrateDown(admin, { env: "test", to: 22 }), range(TOP, 23), "no provider evidence: 0023 rolls back");
    assert.deepEqual(await history(admin), [range(1, 22), range(23, TOP)]);
    assert.deepEqual(await schema(admin), await schema(c22), "rolled-back 22 == forward-built 22 (0021 fence body restored, no receipts / completion)");
    assert.equal(await v1(), r0, "render rows unchanged");
    assert.deepEqual(await migrateUp(admin, { env: "test" }), range(23, TOP));
    assert.deepEqual(await schema(admin), atTop, "identical re-up");
    await plant("gn-v2");
    const a1 = await audit(admin); const s1 = await schema(admin);
    assert.match((await pgErr(() => migrateDown(admin, { env: "test", to: 22 }))).message, /^MIGRATION_0023_DOWN_REFUSED/);
    assert.deepEqual(await history(admin), [range(1, 23), TOP > 23 ? range(24, TOP) : []]);   // C107: 0024 rolled back first (no claimed request)
    assert.equal(await audit(admin), a1);
    assert.deepEqual(await migrateUp(admin, { env: "test" }), TOP > 23 ? range(24, TOP) : []);
    assert.deepEqual(await history(admin), [range(1, TOP), []]); assert.deepEqual(await schema(admin), s1);
  } finally { await admin.end(); await c22.end(); f22.stop(); await m.close(); }
  assert.equal(netAttempts, 0, "no network attempt in the whole suite");
});
