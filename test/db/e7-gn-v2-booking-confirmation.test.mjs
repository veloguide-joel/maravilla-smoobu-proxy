// Stage E7 guest notification — gn-v2 BOOKING-CONFIRMATION OFFLINE INTEGRATION (C41, migration 0022) against DISPOSABLE local PostgreSQL clusters.
// Real schema 0022 + the accepted lifecycle chain (R → C → W) to a confirmed booking with ONE pristine guest.notify → the opt-in worker path
// (confirmationLocale 'en' | 'es') → the accepted gn-v2 builder over the accepted bcc-v1 copy → ONE injected in-memory mock send → durable
// completion through the unchanged 0016 settlement. Fail-closed guards: options, templates, scope, protection, snapshot / recipient binding,
// claim / pre-send version + metadata binding, executor and DB-commit faults (never a resend), SQL cross-field CHECK, ACL, append-only audit,
// and the 0022 down refusal / exact rollback.
//
// TRUST / SHAPE LABELS
//   * Every provider object is a SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED mock (the accepted lifecycle-rehearsal world, copied test-locally,
//     verbatim, from test/db/e7-guest-notification-worker.test.mjs). The ONLY "send" is the injected in-memory sink: it records frozen
//     synthetic requests in memory and never prints them. `mock-` ids / `.invalid` addresses are restrictions / correlation, not proof of a mock.
//   * Guest rows use synthetic `.invalid` addresses (the out-of-scope row uses a synthetic `.example` address that is never sent). Assertions
//     on request content compare booleans so a failure never prints a recipient, name, subject or body. USD only.
//   * The content hash is a TRUST field: SQL binds the request VERSION, message_ref prefix, template, locale and copy contract version; it
//     cannot re-derive the rendered body. The worker binds the body by comparing the stored hash with the frozen request right before the send.
//   * Protected ids 70636076 / 71045356 / 71072615 / 71081885 appear only as fixture references; the worker must give them zero writes.
//   * TEST SETUP writes are labelled at the call (owner session; fixtures.ownerManagedHistory where triggers must be bypassed).
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
import { runNotificationStep, NOTIFICATION_V2_OPTION_KEY, V2_SNAPSHOT_FACT_KEYS } from "../../lib/booking-db/notification-worker.js";
import { buildBookingConfirmationRequest, REQUEST_KEYS_V2 } from "../../lib/checkout/booking-confirmation-request.js";
import { contentHash as contentHashV1 } from "../../lib/checkout/guest-notification.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { migrateDown, migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline gn-v2 integration suite)"); };

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
async function expectedV2(bk, locale) {
  const i = await one("SELECT ref, from_date::text AS a, to_date::text AS b, (to_date - from_date) AS n, guests, final_total_minor AS t, currency FROM booking.intents WHERE id = $1", [bk.id]);
  const g = await one("SELECT email, first_name FROM booking.intent_guests WHERE intent_id = $1", [bk.id]);
  return buildBookingConfirmationRequest({ template: "booking_confirmed", locale, opId: bk.op.id, sender: { ...SENDER }, guest: { email: g.email, firstName: g.first_name },
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

// =============================================================================================

test("A1 EN and ES acceptance: real schema 0022, accepted chain → confirmed / pristine guest.notify → ONE gn-v2 mock send each; exact 11-field request; immutable render binds version / ref / locale / copy / hash; succeeded / 1; repeated steps send nothing", async () => {
  assert.deepEqual((await migrationStatus(db.owner, { env: "test" })).applied, range(1, TOP), "the suite runs on the full chain (0022 included)");
  for (const locale of ["en", "es"]) {
    const bk = await confirmedBooking(); const snk = sink();
    assert.equal(await klass(bk.op.id), "ELIGIBLE");
    assert.deepEqual([bk.op.state, bk.op.attempts, bk.op.dispatched_at], ["pending", 0, null], `${locale}: pristine guest.notify`);
    const exp = await expectedV2(bk, locale);
    assert.equal(exp.ok, true);
    let ps = null;
    const r = PII_FREE(await step(bk, snk, { ...v2(locale), hooks: { afterClaim: async (op) => { ps = await presendRaw(op, "gn2-1"); } } }));
    assert.deepEqual([r.ok, r.outcome, r.sends, r.template, r.requestVersion, r.locale, r.release], [true, "accepted", 1, "booking_confirmed", "gn-v2", locale, "RELEASED"], locale);
    assert.equal(snk.invocations, 1, `${locale}: ONE actual invocation`);
    const req = snk.requests[0];
    assert.ok(Object.isFrozen(req), "frozen request");
    assert.deepEqual(Object.keys(req).sort(), [...REQUEST_KEYS_V2], "exactly the 11 gn-v2 request keys");
    assert.ok(JSON.stringify(req) === JSON.stringify(exp.request), `${locale}: the invoked request is exactly the builder's request for the bound rows (boolean compare)`);
    assert.ok(req.templateVersion === "gn-v2" && req.copyContractVersion === "bcc-v1" && req.locale === locale && req.messageRef === `gn2-${bk.op.id}` && req.from === SENDER.fromAddress, "version / copy / locale / ref / sender");
    assert.ok(locale === "en" ? req.subject.startsWith("Your maraVilla booking") && req.text.includes("Payment received: $") : req.subject.startsWith("Tu reservación de maraVilla") && req.text.includes("Pago recibido: $"), `${locale}: copy language`);
    // the immutable render: SQL-bound request version / message ref / locale / copy contract version; the TRUST content hash = the invoked request's
    const rd = await renderOf(bk.op.id);
    assert.deepEqual([rd.template, rd.template_version, rd.message_ref, rd.locale, rd.copy_contract_version, rd.worker], ["booking_confirmed", "gn-v2", `gn2-${bk.op.id}`, locale, "bcc-v1", "gn2-1"]);
    assert.equal(rd.content_hash, exp.contentHash, "stored hash = the builder's gn-v2 content hash");
    assert.equal(rd.content_hash, sha(`gn-v2-content\n${JSON.stringify(Object.fromEntries(Object.keys(req).sort().map((k) => [k, req[k]])))}`), "independently recomputed over the invoked request");
    assert.notEqual(rd.content_hash, contentHashV1(req), "never the gn-v1 hash");
    assert.equal(rd.recipient_hash, exp.recipientHash);
    assert.equal(r.contentHashPrefix, rd.content_hash.slice(0, 8));
    // the fresh pre-send the worker compared: same version / ref / hash / locale / copy as the frozen request
    assert.deepEqual([ps.ok, ps.templateVersion, ps.messageRef, ps.contentHash, ps.locale, ps.copyContractVersion], [true, "gn-v2", req.messageRef, rd.content_hash, locale, "bcc-v1"]);
    assert.deepEqual(Object.keys(ps).sort(), [...PRESEND16_KEYS, "copyContractVersion", "locale"].sort(), "gn-v2 pre-send = the 0016 keys + locale + copyContractVersion");
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.attempts, op.result_ref, op.lease_worker_id, op.error_code], ["succeeded", 1, "mock-gn2-1", null, null]);
    assert.equal(await casesOf(bk.id), 0);
    const d = await digest(bk);
    for (let k = 0; k < 3; k++) assert.equal((await step(bk, snk, { ...v2(locale), workerId: `gn2-r${k}` })).outcome, "idle");
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, snk, { workerId: `gn2-v1-${k}` })).outcome, "idle", "the default gn-v1 path never takes a sent row either");
    assert.deepEqual(await recover([bk.listingId], null, 10), { processed: 0, skippedLocked: 0, skippedProtected: 0 });
    assert.equal(snk.invocations, 1, `${locale}: sends 1 total`);
    assert.equal(await num("SELECT count(*) AS n FROM booking.notification_renders WHERE operation_id = $1", [bk.op.id]), 1, "one claim / audit");
    assert.equal(await digest(bk), d, "repeated steps: no write");
    // append-only: the render cannot be changed by anyone (owner trigger; runtime role has no UPDATE / DELETE privilege)
    const eo = await pgErr(() => db.owner.query("UPDATE booking.notification_renders SET locale = $2 WHERE operation_id = $1", [bk.op.id, locale === "en" ? "es" : "en"]));
    assert.ok(/IMMUTABLE|append|reject|not allowed/i.test(eo.message), eo.message.slice(0, 80));
    assert.equal((await pgErr(() => db.app.query("DELETE FROM booking.notification_renders WHERE operation_id = $1", [bk.op.id]))).code, "42501");
    assert.equal(await digest(bk), d);
  }
  assert.equal(netAttempts, 0);
});

test("A2 default path unchanged on schema 0022: no confirmationLocale → gn-v1 request / hash / render (no locale / copy metadata) and the 0016 pre-send keys only", async () => {
  const bk = await confirmedBooking(); const snk = sink(); let ps = null;
  const r = PII_FREE(await step(bk, snk, { hooks: { afterClaim: async (op) => { ps = await presendRaw(op, "gn2-1"); } } }));
  assert.deepEqual([r.outcome, r.sends, r.template, "requestVersion" in r, "locale" in r], ["accepted", 1, "booking_confirmed", false, false]);
  const req = snk.requests[0];
  assert.ok(req.templateVersion === "gn-v1" && req.messageRef === `gn1-${bk.op.id}` && !("locale" in req) && req.text.startsWith("Hello "), "gn-v1 request");
  const rd = await renderOf(bk.op.id);
  assert.deepEqual([rd.template_version, rd.message_ref, rd.locale, rd.copy_contract_version], ["gn-v1", `gn1-${bk.op.id}`, null, null]);
  assert.equal(rd.content_hash, contentHashV1(req));
  assert.deepEqual(Object.keys(ps).sort(), PRESEND16_KEYS, "gn-v1 pre-send output: exactly the 0016 keys");
});

test("A3 option gate: present-undefined / null / unknown locale, accessor, missing or null intentId with the opt-in → OPTIONS_INVALID with ZERO queries; the language is never guessed", async () => {
  const bk = { id: "00000000-0000-4000-8000-0000000000c1", listingId: 891999 }; const snk = sink();
  let getterRuns = 0;
  const bad = [v2(undefined), v2(null), v2("EN"), v2("es-MX"), v2("fr"), v2(""), v2(1), v2(["en"]), { ...v2("en"), intentId: undefined }, { ...v2("es"), intentId: null }];
  const withAccessor = gnOpts(bk, snk); Object.defineProperty(withAccessor, NOTIFICATION_V2_OPTION_KEY, { enumerable: true, get() { getterRuns += 1; return "en"; } });
  const hidden = gnOpts(bk, snk); Object.defineProperty(hidden, NOTIFICATION_V2_OPTION_KEY, { value: "en", enumerable: false });
  const sym = gnOpts(bk, snk); sym[Symbol(NOTIFICATION_V2_OPTION_KEY)] = "en";
  for (const o of [...bad.map((x) => gnOpts(bk, snk, x)), withAccessor, hidden, sym]) {
    const p = wrapPool(db.app);
    const r = await runNotificationStep(p, o);
    assert.deepEqual(r, { ok: false, code: "OPTIONS_INVALID" });
    assert.deepEqual(p.log, [], "zero queries");
  }
  assert.equal(getterRuns, 0, "the accessor is refused, never invoked");
  assert.equal(snk.invocations, 0);
});

test("A4 the opt-in covers booking_confirmed ONLY: both failure templates → TEMPLATE_NOT_V2 before any claim / latch / send, work released, row still pristine and eligible", async () => {
  for (const mk of [releasedBooking, cancelledBooking]) {
    const bk = await mk(); const snk = sink(); const p = wrapPool(db.app);
    const d0 = await digest(bk);
    const r = PII_FREE(await step(bk, snk, v2("en"), p));
    assert.deepEqual([r.outcome, r.code, r.sends, r.release, snk.invocations], ["not_claimable", "TEMPLATE_NOT_V2", 0, "RELEASED", 0]);
    assert.ok(!p.log.some((k) => /claim_guest_notification|latch_guest_notification/.test(k)), "no claim / latch attempted");
    assert.equal(await renderOf(bk.op.id), undefined); assert.equal(await latchOf(bk.op.id), undefined);
    assert.equal(await digest(bk), d0, "row / audit / work byte-unchanged");
    assert.equal(await klass(bk.op.id), "ELIGIBLE", "still the default path's to send");
  }
});

test("A5 out-of-scope recipient, WAITING and protected rows: zero sends, zero claims; protected → zero writes", async () => {
  const out = await confirmedBooking({ guestDomain: "mv-test.example" }); const so = sink();                                      // synthetic, never sent
  assert.equal(await klass(out.op.id), "OUT_OF_V1_SCOPE");
  const ro = await step(out, so, v2("es"));
  assert.deepEqual([ro.outcome, ro.sends, so.invocations], ["idle", 0, 0], "an out-of-scope row is never even acquired");
  const prot = await confirmedBooking(); const sp = sink();
  await dashboard(prot.id, "hostaway_reservation", PROTECTED[0], "not_found", {}, Date.now());
  const dp = await digest(prot);
  const rp = await step(prot, sp, v2("en"));
  assert.deepEqual([rp.outcome, rp.sends, sp.invocations], ["idle", 0, 0]);
  assert.equal(await digest(prot), dp, "protected: zero writes");
  // protection between the snapshot and the claim → claim 'protected', zero writes
  const late = await confirmedBooking(); const sl = sink(); let dl = null;
  const rl = await step(late, sl, { ...v2("es"), hooks: { afterInitialObservation: async () => { await dashboard(late.id, "hostaway_reservation", PROTECTED[1], "not_found", {}, Date.now()); dl = await digest(late); } } });
  assert.deepEqual([rl.outcome, rl.sends, sl.invocations], ["protected", 0, 0]);
  assert.equal(await digest(late), dl);
});

test("A6 bad snapshot envelope / recipient binding → the authorized RENDER_FAILED latch; no claim, no render, no send", async () => {
  const tamper = {
    "v !== 1": (f) => { f.v = 2; }, "envelope template": (f) => { f.template = "not_completed_not_charged"; }, "extra key": (f) => { f.guestEmail = "x@mv-test.invalid"; },
    "missing key": (f) => { delete f.settledEvidenceId; }, "facts mismatch (nights)": (f) => { f.nights += 1; }, "non-USD": (f) => { f.currency = "MXN"; }
  };
  for (const [kind, mut] of [...Object.entries(tamper), ["recipient hash", null]]) {
    const bk = await confirmedBooking(); const snk = sink();
    const p = wrapPool(db.app, { guest_notification_snapshot: async ({ exec }) => { const r = await exec(); const s = r.rows[0].r;
      if (mut) mut(s.facts); else s.recipientHash = "0".repeat(64); return r; } });
    const r = PII_FREE(await step(bk, snk, v2("en"), p));
    assert.deepEqual([r.outcome, r.code, r.sends, snk.invocations], ["latched", "RENDER_FAILED", 0, 0], kind);
    assert.ok(["SNAPSHOT_FACTS_INVALID", "RECIPIENT_HASH_MISMATCH", "NIGHTS_MISMATCH", "CURRENCY_NOT_SUPPORTED"].includes(r.renderCode), `${kind}: ${r.renderCode}`);
    assert.ok(!p.log.some((k) => /claim_guest_notification/.test(k)), `${kind}: no claim`);
    assert.equal(await renderOf(bk.op.id), undefined);
    assert.equal((await latchOf(bk.op.id)).code, "RENDER_FAILED");
    assert.equal((await step(bk, snk, v2("en"))).outcome, "idle"); assert.equal(snk.invocations, 0);
  }
  assert.deepEqual([...V2_SNAPSHOT_FACT_KEYS].length, 17);
});

test("A7 after-claim / pre-send mismatch of version, ref, hash, locale or copy contract → PRESEND_ABORTED_NOT_INVOKED (zero invocation), never re-claimed", async () => {
  const swaps = { templateVersion: (s) => { s.templateVersion = "gn-v1"; }, messageRef: (s) => { s.messageRef = s.messageRef.replace("gn2-", "gn1-"); },
    contentHash: (s) => { s.contentHash = "f".repeat(64); }, locale: (s) => { s.locale = s.locale === "en" ? "es" : "en"; }, copyContractVersion: (s) => { s.copyContractVersion = "bcc-v0"; },
    "locale absent": (s) => { delete s.locale; }, "copy absent": (s) => { delete s.copyContractVersion; } };
  for (const [kind, mut] of Object.entries(swaps)) {
    const bk = await confirmedBooking(); const snk = sink();
    const p = wrapPool(db.app, { guest_notification_presend: async ({ exec }) => { const r = await exec(); mut(r.rows[0].r); return r; } });
    const r = PII_FREE(await step(bk, snk, v2(kind.length % 2 ? "en" : "es"), p));
    assert.deepEqual([r.outcome, r.code, r.abort, r.sends, snk.invocations], ["unknown", "PRESEND_ABORTED_NOT_INVOKED", "REQUEST_MISMATCH", 0, 0], kind);
    const op = await notifyOf(bk.id);
    assert.deepEqual([op.state, op.error_code, op.attempts], ["outcome_unknown", "PRESEND_ABORTED_NOT_INVOKED", 1], kind);
    assert.equal((await renderOf(bk.op.id)).template_version, "gn-v2", "the claim-time render is the durable audit");
    assert.equal(await casesOf(bk.id), 1);
    assert.equal((await step(bk, snk, v2("en"))).outcome, "idle"); assert.equal(snk.invocations, 0);
  }
});

test("A8 executor / reply / DB-commit faults on the v2 path: code-only unknown or durable success, ONE invocation, never resent", async () => {
  for (const [kind, reply, code] of [["throw", () => { throw new Error("synthetic executor failure"); }, "SEND_THREW"],
    ["applied then rejected", () => Promise.reject(new Error("reply lost after apply")), "SEND_THREW"],
    ["non-exact accepted", () => ({ accepted: true, providerMessageId: "mock-x", status: "delivered" }), "REPLY_SHAPE"]]) {
    const bk = await confirmedBooking(); const snk = sink(reply);
    const r = PII_FREE(await step(bk, snk, v2("es")));
    assert.deepEqual([r.outcome, r.code, r.sends, snk.invocations], ["unknown", code, 1, 1], kind);
    assert.deepEqual([(await notifyOf(bk.id)).state, (await renderOf(bk.op.id)).locale], ["outcome_unknown", "es"]);
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, snk, v2("es"))).outcome, "idle");
    assert.equal(snk.invocations, 1, `${kind}: no resend`);
  }
  const boom = () => Object.assign(new Error("synthetic connection loss"), { code: "08006" });
  // completion COMMITTED but the acknowledgement lost → the SAME error object, nothing after, durable success, never resent
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification: async ({ exec }) => { await exec(); throw e; } });
    await assert.rejects(step(bk, snk, v2("en"), p), (x) => x === e);
    assert.equal(p.log.at(-1), "pool:complete_guest_notification", "no query after the outer failure");
    assert.deepEqual([(await notifyOf(bk.id)).state, snk.invocations], ["succeeded", 1]);
    for (let k = 0; k < 2; k++) assert.equal((await step(bk, snk, { ...v2("en"), workerId: `gn2-z${k}` })).outcome, "idle");
    assert.equal(snk.invocations, 1); }
  // completion NOT committed → in_flight persists; never resent (maintenance later turns it unknown after the op lease)
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { complete_guest_notification: () => { throw e; } });
    await assert.rejects(step(bk, snk, v2("es"), p), (x) => x === e);
    assert.deepEqual([(await notifyOf(bk.id)).state, snk.invocations], ["in_flight", 1]);
    assert.equal((await step(bk, snk, v2("es"))).outcome, "idle"); assert.equal(snk.invocations, 1); }
  // pre-send COMMIT loss → the SAME error object, zero invocation
  { const bk = await confirmedBooking(); const snk = sink(); const e = boom();
    const p = wrapPool(db.app, { COMMIT: async ({ exec, n }) => { if (n === 2) { await exec(); throw e; } return exec(); } });
    await assert.rejects(step(bk, snk, v2("en"), p), (x) => x === e);
    assert.deepEqual([(await notifyOf(bk.id)).state, snk.invocations], ["in_flight", 0]); }
});

test("A9 no-await boundary on the v2 path: snapshot → v2 claim → pre-send → ONE invocation right after the pre-send COMMIT / release", async () => {
  const bk = await confirmedBooking(); const snk = sink();
  const pool = wrapPool(db.app); snk.lastEvent = () => pool.log.at(-1);
  assert.equal((await step(bk, snk, v2("es"), pool)).outcome, "accepted");
  assert.deepEqual(pool.log, ["pool:marker", "pool:clock", "pool:recover_expired_notifications", "pool:claim_notification_work",
    "connect", "tx:BEGIN", "tx:guest_notification_snapshot", "tx:COMMIT", "release", "pool:claim_guest_notification_v2",
    "connect", "tx:BEGIN", "tx:guest_notification_presend", "tx:COMMIT", "release", "pool:complete_guest_notification", "pool:release_notification_work"]);
  assert.deepEqual(snk.events, ["release"], "nothing between the pre-send COMMIT / connection release and the one invocation");
});

test("A10 SQL fences: old six-argument claim refuses gn-v2; v2 claim refuses bad locale / other templates; cross-field CHECK refuses every mixed combination; ACL; raw runtime writes refused", async () => {
  // a pristine booking_confirmed row and a pristine failure-template row, each holding a real work lease for this worker
  const ok = await confirmedBooking(); const rel = await releasedBooking();
  const work = async (bk) => (await app1("SELECT booking.claim_notification_work($1, $2, $3) AS r", ["gn2-sql", [bk.listingId], bk.id])).r;
  assert.equal((await work(ok)).status, "acquired"); assert.equal((await work(rel)).status, "acquired");
  const H = "a".repeat(64);
  const snap = async (opId) => { const c = await db.app.connect();
    try { await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const r = (await c.query("SELECT booking.guest_notification_snapshot($1) AS r", [opId])).rows[0].r; await c.query("COMMIT"); return r; } finally { c.release(); } };
  const s1 = await snap(ok.op.id); const s2 = await snap(rel.op.id);
  const d1 = await digest(ok); const d2 = await digest(rel);
  // (1) the 0016 claim still refuses any version but gn-v1
  for (const v of ["gn-v2", "GN-V1", null]) {
    const e = await pgErr(() => db.app.query("SELECT booking.claim_guest_notification($1, $2, $3, $4, $5, $6) AS r", [ok.op.id, "gn2-sql", v, H, s1.factsHash, s1.recipientHash]));
    assert.match(e.message, /^NOTIFY_ARGUMENT_INVALID/, String(v));
  }
  // (2) the v2 claim: explicit locale only
  for (const l of ["fr", "EN", "", null]) {
    const e = await pgErr(() => db.app.query("SELECT booking.claim_guest_notification_v2($1, $2, $3, $4, $5, $6) AS r", [ok.op.id, "gn2-sql", l, H, s1.factsHash, s1.recipientHash]));
    assert.match(e.message, /^NOTIFY_ARGUMENT_INVALID/, String(l));
  }
  // (3) the v2 claim never claims / latches / renders another template
  const t = (await app1("SELECT booking.claim_guest_notification_v2($1, $2, $3, $4, $5, $6) AS r", [rel.op.id, "gn2-sql", "en", H, s2.factsHash, s2.recipientHash])).r;
  assert.deepEqual(t, { status: "not_claimable", code: "TEMPLATE_NOT_V2" });
  assert.equal(await digest(ok), d1); assert.equal(await digest(rel), d2, "TEMPLATE_NOT_V2: zero writes");
  // (4) raw runtime writes are refused: no INSERT on the audit; the claim transition needs the dedicated function's token
  assert.equal((await pgErr(() => db.app.query(`INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
     content_hash, message_ref, worker, claimed_at, locale, copy_contract_version) VALUES ($1::uuid, $2::uuid, 'booking_confirmed', 'gn-v2', 0, '{}', $3, $3, $3, 'gn2-' || $1::uuid::text, 'w', now(), 'en', 'bcc-v1')`,
    [ok.op.id, ok.id, H]))).code, "42501");
  const ru = await pgErr(() => db.app.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'x', lease_until = now() + interval '1 minute' WHERE id = $1", [ok.op.id]));
  assert.match(ru.message, /NOTIFY_CLAIM_AUTHORITY|permission denied/);
  // (5) the cross-field CHECK (owner TEST SETUP inserts, each refused by the constraint; nothing written)
  const owner = (ver, ref, tpl, loc, copy) => db.owner.query(`INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash,
     recipient_hash, content_hash, message_ref, worker, claimed_at, locale, copy_contract_version) VALUES ($1::uuid, $2::uuid, $3, $4, 0, '{}', $5, $5, $5, $6 || $1::uuid::text, 'w', now(), $7, $8)`,
    [ok.op.id, ok.id, tpl, ver, H, ref, loc, copy]);
  const BC = "booking_confirmed";
  for (const [kind, args] of [["v2 + gn1 prefix", ["gn-v2", "gn1-", BC, "en", "bcc-v1"]], ["v1 + gn2 prefix", ["gn-v1", "gn2-", BC, null, null]],
    ["v2 + failure template", ["gn-v2", "gn2-", "not_completed_not_charged", "en", "bcc-v1"]], ["v2 + unknown locale", ["gn-v2", "gn2-", BC, "fr", "bcc-v1"]],
    ["v2 + no locale", ["gn-v2", "gn2-", BC, null, "bcc-v1"]], ["v2 + other copy", ["gn-v2", "gn2-", BC, "es", "bcc-v2"]], ["v2 + no copy", ["gn-v2", "gn2-", BC, "es", null]],
    ["v1 + locale", ["gn-v1", "gn1-", BC, "en", null]], ["v1 + copy", ["gn-v1", "gn1-", BC, null, "bcc-v1"]], ["unknown version", ["gn-v3", "gn2-", BC, "en", "bcc-v1"]]]) {
    const e = await pgErr(() => owner(...args));
    assert.deepEqual([e.code, e.constraint], ["23514", "notification_renders_version_binding"], kind);
  }
  assert.equal(await renderOf(ok.op.id), undefined, "nothing written");
  // (6) ACL: SECURITY DEFINER, fixed search_path, EXECUTE for the owner + runtime role only (no PUBLIC / report / admin)
  const f = await one(`SELECT p.prosecdef, array_to_string(p.proconfig, ',') AS cfg, array_to_string(p.proacl, ',') AS acl FROM pg_proc p
                        WHERE p.oid = 'booking.claim_guest_notification_v2(uuid,text,text,text,text,text)'::regprocedure`);
  assert.deepEqual([f.prosecdef, f.cfg, f.acl], [true, "search_path=pg_catalog, booking", "postgres=X/postgres,mv_booking_app=X/postgres"]);
  assert.equal(f.acl, (await one("SELECT array_to_string(proacl, ',') AS a FROM pg_proc WHERE oid = 'booking.claim_guest_notification(uuid,text,text,text,text,text)'::regprocedure")).a, "same boundary as the 0016 claim");
  const rep = new pg.Client({ connectionString: db.reportUrl() }); await rep.connect();
  try { assert.equal((await rep.query("SELECT has_function_privilege('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)', 'EXECUTE') AS x")).rows[0].x, false); } finally { await rep.end(); }
  assert.equal((await db.reconciler.query("SELECT has_function_privilege('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)', 'EXECUTE') AS x")).rows[0].x, false, "admin: none");
  // both rows remain untouched and claimable by their own paths afterwards (leases released by the accepted function)
  for (const bk of [ok, rel]) assert.equal(await app1("SELECT booking.release_notification_work($1, $2) AS r", [bk.id, "gn2-sql"]).then((x) => x.r), "RELEASED");
});

test("A11 migration 0022: refused down while ANY gn-v2 render exists (succeeded and unknown here) — audit and schema unchanged; on a separate fresh cluster with only gn-v1 audit, exact 22 → 21 == forward-built 21, v1 row unchanged, identical re-up; a planted gn-v2 render then refuses", async () => {
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
  const audit = async (c) => (await c.query("SELECT md5(coalesce(string_agg(row_to_json(r)::text, '|' ORDER BY r.operation_id), '')) AS d FROM booking.notification_renders r")).rows[0].d;
  // (1) THIS suite's database: gn-v2 renders exist in succeeded AND outcome_unknown operations → the down refuses, nothing changes
  const states = (await db.owner.query(`SELECT DISTINCT o.state FROM booking.notification_renders r JOIN booking.external_operations o ON o.id = r.operation_id
                                         WHERE r.template_version = 'gn-v2' ORDER BY 1`)).rows.map((x) => x.state);
  assert.ok(states.includes("succeeded") && states.includes("outcome_unknown"), states.join(","));
  const own = new pg.Client({ connectionString: db.adminUrl }); await own.connect();
  try {
    const s0 = await schema(own); const a0 = await audit(own);
    const e = await pgErr(() => migrateDown(own, { env: "test", to: TOP - 1 }));
    assert.match(e.message, /^MIGRATION_0022_DOWN_REFUSED/);
    assert.deepEqual(await history(own), [range(1, TOP), []], "nothing rolled back");
    assert.equal(await audit(own), a0, "the gn-v2 audit is byte-equal (never deleted / rewritten)");
    assert.deepEqual(await schema(own), s0);
  } finally { await own.end(); }
  // (2) a separate disposable cluster with ONE gn-v1 render (TEST SETUP, as the 0016 fence suite plants it) → exact rollback / re-up
  const m = await startMigratedDatabase(); const f21 = await startPostgres();
  const admin = new pg.Client({ connectionString: m.adminUrl }); await admin.connect();
  const c21 = new pg.Client({ connectionString: f21.adminUrl }); await c21.connect();
  try {
    assert.deepEqual(await migrateUp(c21, { env: "test", to: 21 }), range(1, 21));
    assert.deepEqual(await history(c21), [range(1, 21), range(22, TOP)], "forward-built 21");
    const atTop = await schema(admin);
    const id = (await createIntentRecord(m.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: Date.now(), listingId: 999022, from: "2027-02-10", to: "2027-02-12", guests: 2 })).id;
    await F.ownerManagedHistory(m.owner, `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, attempts,
       next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), '${id}', 'guest.notify', 'notify:${id}:booking_confirmed', 'idempotent', 'pending', '{"template":"booking_confirmed"}', 0, 5, 0, now(), now(), now())`);
    const op = (await admin.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id])).rows[0].id;
    const SYN = "b".repeat(64);
    await F.ownerManagedHistory(m.owner, `INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
       content_hash, message_ref, worker, claimed_at) VALUES ($1::uuid, $2::uuid, 'booking_confirmed', 'gn-v1', 0, '{}', $3, $3, $3, 'gn1-' || $1::uuid::text, 'w', now())`, [op, id, SYN]);
    const v1row = async () => (await admin.query(`SELECT md5(row_to_json(r)::text) AS d FROM (SELECT ${AUDIT16} FROM booking.notification_renders) r`)).rows[0].d;
    const r0 = await v1row();
    assert.deepEqual(await migrateDown(admin, { env: "test", to: 21 }), range(TOP, 22), "gn-v1 audit only: 0022 rolls back");
    assert.deepEqual(await history(admin), [range(1, 21), range(22, TOP)]);
    assert.deepEqual(await schema(admin), await schema(c21), "rolled-back 21 == forward-built 21 (0016 presend body, constraints, columns, ACL)");
    assert.equal(await v1row(), r0, "the gn-v1 render values are unchanged");
    assert.equal((await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'notification_renders_template_version_check'")).rows[0].d, "CHECK ((template_version = 'gn-v1'::text))");
    assert.deepEqual(await migrateUp(admin, { env: "test" }), range(22, TOP));
    assert.deepEqual(await history(admin), [range(1, TOP), []]);
    assert.deepEqual(await schema(admin), atTop, "identical re-up");
    assert.equal(await v1row(), r0);
    // a gn-v2 render (TEST SETUP, a second synthetic row; no send) → the down refuses, every row unchanged
    const id2 = (await createIntentRecord(m.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: Date.now(), listingId: 999022, from: "2027-03-10", to: "2027-03-12", guests: 2 })).id;
    await F.ownerManagedHistory(m.owner, `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, attempts,
       next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), '${id2}', 'guest.notify', 'notify:${id2}:booking_confirmed', 'idempotent', 'pending', '{"template":"booking_confirmed"}', 0, 5, 0, now(), now(), now())`);
    const op2 = (await admin.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id2])).rows[0].id;
    await F.ownerManagedHistory(m.owner, `INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash,
       content_hash, message_ref, worker, claimed_at, locale, copy_contract_version) VALUES ($1::uuid, $2::uuid, 'booking_confirmed', 'gn-v2', 0, '{}', $3, $3, $3, 'gn2-' || $1::uuid::text, 'w', now(), 'es', 'bcc-v1')`, [op2, id2, SYN]);
    const a1 = await audit(admin); const s1 = await schema(admin);
    const e2 = await pgErr(() => migrateDown(admin, { env: "test", to: 21 }));
    assert.match(e2.message, /^MIGRATION_0022_DOWN_REFUSED/);
    assert.deepEqual(await history(admin), [range(1, TOP), []]);
    assert.equal(await audit(admin), a1); assert.deepEqual(await schema(admin), s1);
  } finally { await admin.end(); await c21.end(); f21.stop(); await m.close(); }
  assert.equal(netAttempts, 0, "no network attempt in the whole suite");
});
