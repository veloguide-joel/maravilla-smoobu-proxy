// e7-0022-0023-sqleditor-apply-wrapper — proves claude/e7-0022-0023-sqleditor-apply-v1.sql + claude/e7-0022-0023-readback-v1.sql (C46) on DISPOSABLE
// PostgreSQL ONLY. LABELLED SPECIALISATION of test/db/e7-0021-sqleditor-apply-wrapper.test.mjs for TWO migrations (0022 then 0023) on a cluster that carries
// EXACTLY 0001-0021. The packet is reviewable tooling for the shared DEV TEST database; ROOT reviews and owns any actual shared apply — nothing here
// touches a shared database. Lifecycle helpers below are copied test-locally, verbatim, from test/db/e7-gn-v2-booking-confirmation.test.mjs (itself
// copied from the accepted worker suite) and run against a database migrated to EXACTLY 21. Synthetic `.invalid` addresses (the queued "real
// address" row uses `.example` and is never acquired); notification sends are an in-memory sink; no network, no provider, no credential.
// Scenarios: C0 deterministic assembly + continuity with the accepted 0021 POST pins; C1 healthy apply over REALISTIC schema-21 history (old gn-v1 notify
// audit, unknown notify + case, queued out-of-scope notify, released / cancelled, held claims incl. reconciliation_required, stopped capture_unknown,
// captured + refunded history) with every booking table's rows preserved over the PRE column set, the original 12 render columns, the intent set,
// whole 0001-0021 history rows, NULL new render columns, EMPTY receipts; exact-POST replay no-op; C2 refusals leave schema / data / history unchanged;
// C3 STOP states (schema 22, POST drift, foreign checksum) + migrator-built 23 is the exact POST; C4 atomic rollback by fault injection + the real time
// bound; C5 the disposable-only no-evidence rollback comparison (never an operator shared DOWN).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { runNotificationStep } from "../../lib/booking-db/notification-worker.js";
import { priceStay } from "../../lib/checkout/server-pricer.js";
import { readDirectPolicyFromEnv } from "../../lib/direct-policy.js";
import { todayInTimeZone } from "../../lib/public-api.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { migrateDown, migrateUp, migrationStatus, loadMigrations } from "../../db/lib/migrate.js";

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LOCK_KEY } from "../../scripts/e7-connected/run-lock-precheck.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const WRAPPER = rd("claude/e7-0022-0023-sqleditor-apply-v1.sql"); const READBACK = rd("claude/e7-0022-0023-readback-v1.sql");
const INVENTORY = rd("claude/e7-0022-0023-inventory.sql"); const PINS = JSON.parse(rd("claude/e7-0022-0023-pins-v1.json"));
const PINS21 = JSON.parse(rd("claude/e7-0021-pins-v1.json"));
const IDENTITY_KEYS = ["functions", "function_count", "triggers", "trigger_count", "constraints", "indexes", "columns", "table_acls", "rls", "rls_enabled_count", "policies", "policy_count",
  "schema_owner", "is_privileged_src", "is_privileged_config", "relations", "relation_count", "test_cleanup_pending_state", "prerequisite_0021", "objects", "acls"];
const GENERIC = IDENTITY_KEYS.slice(0, 15).concat(["test_cleanup_pending_state"]);
const identity = (inv) => Object.fromEntries(IDENTITY_KEYS.map((k) => [k, inv[k]]));
const M = loadMigrations(); const m22 = M.find((m) => m.version === 22); const m23 = M.find((m) => m.version === 23);
/** the SPENT accepted packet artifacts (never altered by C46) */
const SPENT = Object.freeze({ "claude/e7-0021-sqleditor-apply-v1.sql": "53ad7869ef01d1672a99ede21b7c569daa64be67c2fac8b2707a93b90800b4b2", "claude/e7-0021-readback-v1.sql": "aff1ca5def619c75581de7fed5f2fadce3c05ee4bcb3afed19fa3df37a750773",
  "claude/e7-0021-inventory.sql": "c456f8258cb12c111b8fb2fcf75755c3435a1b5924f8b37f1131a2e45c1e20fa", "claude/e7-0021-pins-v1.json": "8e647afe462d049d3cf810e0e2cbead41552d4fcbe741b933f30d70051c04d4b",
  "claude/gen-0021-wrapper.py": "8246783f57b1da2e3c2109481167debdb4034357758937e29ff44fe62676212f", "claude/derive-0021-pins.mjs": "75c35275eb590477baa12e442f0d0d0da00f2b1f74aed6e5291a1cac716ba0da",
  "claude/e7-0019-0020-sqleditor-apply-v1.sql": "528eeee53a89dd4f5b072fe2f7ce1f8f28f0e11d87ef08bd95ebc8fc5562f425", "claude/e7-0019-0020-pins-v1.json": "9edf7888248d76fb476de3712c915b76d1545f71585640d28ff1048eb6619c43" });

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline C46 suite)"); };

/** a disposable cluster migrated to EXACTLY `to`, with the startMigratedDatabase login roles and pools (test-local; the shared harness is unchanged) */
async function startDbAt(to) {
  const base = await startPostgres();
  const admin = new pg.Client({ connectionString: base.adminUrl }); await admin.connect();
  try {
    await migrateUp(admin, { env: "test", to });
    await admin.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    await admin.query("CREATE ROLE test_report LOGIN IN ROLE mv_booking_report");
    await admin.query("CREATE ROLE test_admin LOGIN IN ROLE mv_booking_admin");
  } finally { await admin.end(); }
  const app = new pg.Pool({ connectionString: base.appUrl(), max: 12 }); const owner = new pg.Pool({ connectionString: base.adminUrl, max: 4 });
  const reconciler = new pg.Pool({ connectionString: base.adminUrl2(), max: 3 });
  const c = new pg.Client({ connectionString: base.adminUrl }); await c.connect();
  return { ...base, app, owner, reconciler, c,
    async close() { await c.end().catch(() => {}); await app.end().catch(() => {}); await owner.end().catch(() => {}); await reconciler.end().catch(() => {}); base.stop(); } };
}
const inventory = async (c) => (await c.query(INVENTORY)).rows[0].e7_inventory;
const readback = async (c) => (await c.query(READBACK)).rows[0].e7_23_readback;
async function runWrapper(c, text = WRAPPER) {
  const notices = []; const on = (n) => notices.push(n.message); c.on("notice", on);
  try { const res = await c.query(text); return { status: res[res.length - 1].rows[0].e7_23_status, notices }; } finally { c.off("notice", on); }
}
const expectRaise = async (c, re, text) => { let msg = null; try { await runWrapper(c, text); } catch (e) { msg = e.message; } assert.ok(msg && re.test(msg), `expected ${re}, got ${msg}`); };
async function unchanged(c, pre) {
  const rb = await readback(c);
  assert.deepEqual(identity(rb.identity), identity(pre.identity), "schema identity unchanged");
  assert.deepEqual(rb.identity.migrations, pre.identity.migrations, "history unchanged");
  assert.deepEqual(rb.data, pre.data, "rows unchanged"); assert.equal(rb.receipts_rows, pre.receipts_rows);
}
const pgErr = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail("expected a database error"); };

let db;   // the lifecycle helpers below read this binding: a database at EXACTLY 21 with realistic history
before(async () => { db = await startDbAt(21); });
after(async () => { globalThis.fetch = realFetch; await db.close(); });

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

// ---------------------------------------------------------------------------------------------

async function seedRealistic21() {
  const notes = {};
  // (a) an OLD gn-v1 notify audit: confirmed via R → C → W, the default gn-v1 worker accepted by the in-memory sink
  const a = await confirmedBooking(); const sa = sink((n) => ({ accepted: true, providerMessageId: `mock-gn1-${n}` }));
  assert.equal((await step(a, sa)).outcome, "accepted"); notes.v1 = a;
  // (b) a gn-v1 notify outcome_unknown with its reconciliation case (never resent)
  const b = await confirmedBooking(); assert.equal((await step(b, sink(() => ({ accepted: false, unknown: true, code: "SEND_TIMEOUT" })))).outcome, "unknown"); notes.unknown = b;
  // (c) a confirmed booking whose queued notify carries an out-of-scope ("real-shaped") address: pending, never acquired
  const c = await confirmedBooking({ guestDomain: "mv-test.example" }); assert.equal((await step(c, sink())).outcome, "idle"); notes.queued = c;
  // (d) released (void) and (e) cancelled histories
  notes.released = await releasedBooking(); notes.cancelled = await cancelledBooking();
  // (f) held claims: reservation_confirmed and reconciliation_required (ESCALATE) both keep their inventory claim
  const f = await F.reserved(db.app, { listingId: 772301 });
  const g = await F.reserved(db.app, { listingId: 772302 }); F.ok(await applyEvent(db.app, g.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(8) }));
  // (h) a STOPPED capture_unknown (accepted 0017 suite pattern)
  const h = await F.reserved(db.app, { listingId: 772303 });
  await F.runOp(db.app, h.id, "stripe.capture_payment_intent", 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok(await applyEvent(db.app, h.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(8) }));
  // (i) captured + a historical succeeded refund row (owner-managed history, TEST SETUP)
  const i = await F.captured(db.app, { listingId: 772304 });
  await F.ownerManagedHistory(db.owner, `INSERT INTO booking.payment_refunds (id, intent_id, seq, idempotency_key, stripe_refund_id, amount_minor, currency, reason_code, requested_by, state, hostaway_state, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::uuid, 1, 'ref:' || $1::uuid::text || ':1', 're_test_c46', 1000, 'USD', 'GUEST_CANCELLED', 'admin', 'succeeded', 'recorded', now(), now())`, [i.id]);
  const st = Object.fromEntries((await db.owner.query("SELECT state, count(*)::int AS n FROM booking.intents GROUP BY state")).rows.map((r) => [r.state, r.n]));
  for (const s of ["confirmed", "authorization_released", "cancelled", "reservation_confirmed", "reconciliation_required", "capture_unknown", "payment_captured"]) assert.ok(st[s] >= 1, `fixture state ${s}: ${JSON.stringify(st)}`);
  const ops = (await db.owner.query("SELECT state FROM booking.external_operations WHERE op_type = 'guest.notify' ORDER BY state")).rows.map((r) => r.state);
  for (const s of ["succeeded", "outcome_unknown", "pending"]) assert.ok(ops.includes(s), `notify ${s}`);
  assert.ok(Number((await db.owner.query("SELECT count(*) AS n FROM booking.inventory_claims WHERE released_at IS NULL")).rows[0].n) >= 2, "held claims");
  assert.ok(Number((await db.owner.query("SELECT count(*) AS n FROM booking.payment_refunds")).rows[0].n) >= 1, "refund history");
  return notes;
}

let NOTES; let PRE_RB;

test("C0 deterministic assembly: committed pins == a fresh PRE derivation here (schema 21) and == the accepted 0021 packet's POST pins on every generic key; embedded ups are the merged 0022 / 0023 files; no other up / any down embedded; spent packet artifacts untouched; added columns / new tables are catalog deltas; regeneration byte-identical", async () => {
  const pre = await inventory(db.c);
  assert.deepEqual(identity(pre), identity(PINS.pre), "PRE identity == pinned reconstruction of 0001-0021");
  assert.equal(pre.migrations.aggregate, PINS.pre.migrations.aggregate); assert.equal(pre.migrations.count, 21);
  for (const k of GENERIC) assert.deepEqual(PINS.pre[k], PINS21.post[k], `continuity with the accepted 0021 POST pin: ${k}`);
  assert.equal(PINS.pre.migrations.aggregate, PINS21.post.migrations.aggregate, "same 0001-0021 history aggregate as the accepted 0021 packet");
  assert.deepEqual([PINS.files.up22, PINS.files.down22, PINS.files.name22, PINS.files.up23, PINS.files.down23, PINS.files.name23],
    [m22.upChecksum, m22.downChecksum, m22.name, m23.upChecksum, m23.downChecksum, m23.name]);
  assert.equal(/\$e7_0022_up\$([\s\S]*?)\$e7_0022_up\$/.exec(WRAPPER)[1], m22.up); assert.equal(/\$e7_0023_up\$([\s\S]*?)\$e7_0023_up\$/.exec(WRAPPER)[1], m23.up);
  assert.equal(WRAPPER.split("$e7_0022_up$").length, 3); assert.equal(WRAPPER.split("$e7_0023_up$").length, 3);
  for (const m of M) { if (m.version !== 22 && m.version !== 23) assert.ok(!WRAPPER.includes(m.up), `up ${m.version} absent`); assert.ok(!WRAPPER.includes(m.down), `down ${m.version} absent`); }
  assert.ok(!/VALUES \((19|20|21),/.test(WRAPPER), "no 0019 / 0020 / 0021 tracking row");
  for (const [p, h] of Object.entries(SPENT)) assert.equal(sha(rd(p)), h, `spent artifact untouched: ${p}`);
  assert.equal(sha(INVENTORY), PINS.inventorySql);
  assert.ok(WRAPPER.includes(`hashtext('${LOCK_KEY}')`));
  assert.ok(!/RESET |SET statement_timeout|SET lock_timeout/.test(WRAPPER.replace(/SET LOCAL/g, "")), "only SET LOCAL");
  assert.ok(!/migrateDown|DROP (TABLE|FUNCTION|TRIGGER|POLICY)/.test(WRAPPER.replace(/\$e7_002[23]_up\$[\s\S]*?\$e7_002[23]_up\$/g, "")), "the wrapper itself drops nothing and runs no down");
  assert.deepEqual(PINS.addedColumns, { notification_renders: ["locale", "copy_contract_version"] }); assert.deepEqual(PINS.newTables, ["notification_provider_receipts"]);
  assert.deepEqual(PINS.preColumnsOf.notification_renders, ["operation_id", "intent_id", "template", "template_version", "intent_version", "facts", "facts_hash", "recipient_hash", "content_hash", "message_ref", "worker", "claimed_at"]);
  assert.equal(PINS.post.relation_count, PINS.pre.relation_count + 1); assert.equal(PINS.post.rls_enabled_count, PINS.pre.rls_enabled_count + 1);
  assert.ok(Object.values(PINS.pre.objects).every((v) => v === false) && Object.values(PINS.post.objects).every((v) => v === true));
  assert.ok(Object.values(PINS.mid.objects).some((v) => v) && Object.values(PINS.mid.objects).some((v) => !v), "MID = 0022 objects only");
  const doc = rd("claude/e7-0022-0023-apply-operator-sequence.md");
  const manifest = [...doc.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map((x) => [x[1], x[2]]);
  assert.equal(manifest.length, 11, "operator manifest lists every packet + migration file");
  for (const [p, h] of manifest) if (p !== "test/db/e7-0022-0023-sqleditor-apply-wrapper.test.mjs") assert.equal(sha(rd(p)), h, `operator manifest: ${p}`);
  assert.ok(doc.includes(PINS.post.functions) && doc.includes(PINS.pre.migrations.aggregate) && doc.includes(PINS.post.migrations.aggregate), "operator doc carries the expected pins");
  const out = execFileSync("python3", [join(ROOT, "claude/gen-0022-0023-wrapper.py"), ROOT], { encoding: "utf8" });
  assert.ok(out.includes(`sqleditor-apply-v1.sql sha256: ${sha(WRAPPER)}`) && out.includes(`readback-v1.sql sha256: ${sha(READBACK)}`), out);
});

test("C1 healthy apply over REALISTIC schema-21 history: status 23 / two exact rows; MID + POST identity; every pre-existing booking table's count + whole-row fingerprint over the PRE column set, the original 12 render columns, the intent set and whole 0001-0021 history rows identical; new render columns NULL; receipts EMPTY; migrator 1..23 nothing pending; exact-POST replay is a no-op; grants as merged", async () => {
  NOTES = await seedRealistic21();
  PRE_RB = await readback(db.c);
  assert.deepEqual(identity(PRE_RB.identity), identity(PINS.pre)); assert.equal(PRE_RB.instance.environment, "test"); assert.equal(PRE_RB.current_user, "postgres");
  assert.deepEqual(PRE_RB.exclusion, { hosted_run_lock_held: false, work_leases: 0, intent_leases: 0, operation_leases_or_in_flight: 0, prepared_transactions: 0, other_session_write_locks: 0 });
  assert.equal(PRE_RB.renders_non_gn_v1_or_meta, 0); assert.equal(PRE_RB.receipts_rows, null);
  const nonEmpty = Object.entries(PRE_RB.data.booking_tables).filter(([, v]) => !v.startsWith("0:")).map(([k]) => k);
  for (const t of ["intents", "external_operations", "notification_renders", "reconciliation_cases", "inventory_claims", "payment_refunds", "payment_ledger", "intent_transitions"]) assert.ok(nonEmpty.includes(t), `nonempty fixture table ${t}`);
  assert.deepEqual(Object.keys(PRE_RB.data.booking_tables).sort(), PINS.preTables, "fingerprint covers EVERY pre-existing booking table (catalog-derived)");
  assert.ok(PRE_RB.data.renders_original_12.startsWith("2:"), "two gn-v1 renders (accepted + unknown)");
  const intentStates = async () => (await db.owner.query("SELECT id, state, version FROM booking.intents ORDER BY id")).rows;
  const s0 = await intentStates();
  const { status, notices } = await runWrapper(db.c);
  assert.deepEqual(notices, ["E7_23_APPLIED"]);
  assert.deepEqual([status.migrations_max, status.v22, status.v23, status.claim_guest_notification_v2, status.complete_guest_notification_resend, status.receipts_rows, status.functions_sha256],
    [23, true, true, true, true, 0, PINS.post.functions]);
  const post = await readback(db.c);
  assert.deepEqual(identity(post.identity), identity(PINS.post), "POST identity == pinned reconstruction of 0001-0023");
  assert.deepEqual(post.data, PRE_RB.data, "every table / the 12 render columns / intent set / 0001-0021 history rows identical");
  assert.equal(post.renders_non_gn_v1_or_meta, 0, "pre-existing renders still gn-v1, locale / copy metadata NULL"); assert.equal(post.receipts_rows, 0);
  assert.equal(post.identity.migrations.aggregate, PINS.post.migrations.aggregate); assert.equal(post.identity.migrations.aggregate_1_21, PRE_RB.identity.migrations.aggregate);
  assert.deepEqual(post.identity.migrations.v22, { version: 22, name: m22.name, up_checksum: m22.upChecksum, down_checksum: m22.downChecksum, environment: "test" });
  assert.deepEqual(post.identity.migrations.v23, { version: 23, name: m23.name, up_checksum: m23.upChecksum, down_checksum: m23.downChecksum, environment: "test" });
  assert.deepEqual(await intentStates(), s0, "no intent status / version changed");
  assert.equal((await db.owner.query("SELECT state FROM booking.external_operations WHERE id = $1", [NOTES.queued.op.id])).rows[0].state, "pending", "the queued out-of-scope notify is untouched");
  const st = await migrationStatus(db.c, { env: "test" });
  assert.deepEqual(st.applied.at(-1), 23); assert.deepEqual(st.pending, M.filter((m) => m.version > 23).map((m) => m.version));
  assert.deepEqual(await migrateUp(db.c, { env: "test", to: 23 }), [], "migrator agrees: nothing to apply up to 23");
  assert.deepEqual(post.identity.acls["booking.claim_guest_notification_v2(p_op uuid, p_worker text, p_locale text, p_content_hash text, p_recipient_hash text, p_facts_hash text)"] ?? Object.entries(post.identity.acls).find(([k]) => k.startsWith("booking.claim_guest_notification_v2("))[1], ["mv_booking_app=X/postgres", "postgres=X/postgres"]);
  assert.deepEqual(Object.entries(post.identity.acls).find(([k]) => k.startsWith("booking.complete_guest_notification_resend("))[1], ["mv_booking_app=X/postgres", "postgres=X/postgres"]);
  assert.deepEqual(Object.entries(post.identity.acls).find(([k]) => k.startsWith("booking.notification_provider_receipt_binding("))[1], ["postgres=X/postgres"]);
  const rep = new pg.Client({ connectionString: db.reportUrl() }); await rep.connect();
  try { const g = (await rep.query("SELECT has_function_privilege('booking.complete_guest_notification_resend(uuid,text,text,uuid,boolean,text)', 'EXECUTE') AS a, has_table_privilege('booking.notification_provider_receipts', 'SELECT') AS b")).rows[0];
    assert.deepEqual([g.a, g.b], [false, false], "report gained nothing"); } finally { await rep.end(); }
  // exact-POST replay: provable no-op (no write)
  const before2 = await readback(db.c);
  const r2 = await runWrapper(db.c);
  assert.deepEqual(r2.notices, ["E7_23_ALREADY_EXACT_NOOP"]); assert.equal(r2.status.migrations_max, 23);
  const after2 = await readback(db.c);
  assert.deepEqual(after2, before2, "replay changed nothing");
  assert.equal(netAttempts, 0);
});

test("C2 refusals at 21 leave schema / data / history unchanged: wrong environment; history drift (0010, 0021 rows); foreign environment row; wrong role (admin, app); 0021 prerequisite; 0022 vocabulary pre-created; identity drift (extra function, widened ACL, extra table, extra view = catalog-derived relations, RLS off); quiescence (hosted-run lock, work / operation lease, in-flight write, another session's write lock); held migrator lock → 55P03", async () => {
  const B = await startDbAt(21);
  try {
    const pool = B.app; await F.reserved(pool, { listingId: 772401 }); await F.pending(pool, { listingId: 772402, from: "2028-02-01", to: "2028-02-04", currency: "USD" });
    const pre = await readback(B.c); const c = B.c;
    await c.query("UPDATE booking.instance SET environment = 'live'"); await expectRaise(c, /E7_23_NOT_TEST/); await c.query("UPDATE booking.instance SET environment = 'test'"); await unchanged(c, pre);
    for (const v of [10, 21]) {
      const m = M.find((x) => x.version === v);
      await c.query("UPDATE booking_migrations.applied SET up_checksum = repeat('0',64) WHERE version = $1", [v]);
      await expectRaise(c, /E7_23_HISTORY_DRIFT/); await c.query("UPDATE booking_migrations.applied SET up_checksum = $1 WHERE version = $2", [m.upChecksum, v]); await unchanged(c, pre);
    }
    await c.query("UPDATE booking_migrations.applied SET environment = 'live' WHERE version = 5"); await expectRaise(c, /E7_23_ENV_MISMATCH/);
    await c.query("UPDATE booking_migrations.applied SET environment = 'test' WHERE version = 5"); await unchanged(c, pre);
    for (const url of [B.adminUrl2(), B.appUrl()]) {
      const other = new pg.Client({ connectionString: url }); await other.connect();
      try { let msg = null; try { await other.query(WRAPPER); } catch (e) { msg = e.message; } assert.ok(msg && /E7_23_NOT_SCHEMA_OWNER|permission denied/.test(msg), msg); } finally { await other.end(); }
    }
    await unchanged(c, pre);
    await c.query("REVOKE EXECUTE ON FUNCTION booking.suppress_guest_notification(uuid,text) FROM mv_booking_app");
    await expectRaise(c, /E7_23_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/);
    await c.query("GRANT EXECUTE ON FUNCTION booking.suppress_guest_notification(uuid,text) TO mv_booking_app"); await unchanged(c, pre);
    await c.query("ALTER TABLE booking.notification_renders ADD COLUMN locale text"); await expectRaise(c, /E7_23_VOCABULARY_ALREADY_PRESENT/);
    await c.query("ALTER TABLE booking.notification_renders DROP COLUMN locale"); await unchanged(c, pre);
    for (const [make, drop, re] of [
      ["CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$", "DROP FUNCTION booking._e7_extra()", /E7_23_SCHEMA_IDENTITY_DRIFT:.*functions/],
      ["GRANT EXECUTE ON FUNCTION booking.claim_guest_notification(uuid,text,text,text,text,text) TO mv_booking_report", "REVOKE EXECUTE ON FUNCTION booking.claim_guest_notification(uuid,text,text,text,text,text) FROM mv_booking_report", /E7_23_SCHEMA_IDENTITY_DRIFT:.*(functions|acls)/],
      ["CREATE TABLE booking._e7_extra (x int)", "DROP TABLE booking._e7_extra", /E7_23_SCHEMA_IDENTITY_DRIFT:.*relations/],
      ["CREATE VIEW booking._e7_view AS SELECT 1 AS x", "DROP VIEW booking._e7_view", /E7_23_SCHEMA_IDENTITY_DRIFT:.*relations/],
      ["ALTER TABLE booking.notification_renders DISABLE ROW LEVEL SECURITY", "ALTER TABLE booking.notification_renders ENABLE ROW LEVEL SECURITY", /E7_23_SCHEMA_IDENTITY_DRIFT:.*rls/]]) {
      await c.query(make); await expectRaise(c, re); await c.query(drop); await unchanged(c, pre);
    }
    const holder = new pg.Client({ connectionString: B.adminUrl }); await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await expectRaise(c, /E7_23_ACTIVE_RUN_LOCK_HELD/);
      await holder.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0)", [LOCK_KEY]); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("LOCK TABLE booking.intents IN ROW EXCLUSIVE MODE");
      assert.equal((await readback(c)).exclusion.other_session_write_locks >= 1, true);
      await expectRaise(c, /E7_23_BOOKING_WRITE_LOCK_HELD/); await holder.query("ROLLBACK"); await unchanged(c, pre);
      await holder.query("BEGIN"); await holder.query("SELECT pg_advisory_xact_lock(7302215001)");
      let code = null; try { await runWrapper(c); } catch (e) { code = e.code; } assert.equal(code, "55P03", "held migrator lock → lock_timeout");
      await holder.query("ROLLBACK"); await unchanged(c, pre);
    } finally { await holder.end(); }
    const intentId = (await c.query("SELECT id FROM booking.intents ORDER BY created_at LIMIT 1")).rows[0].id;
    await c.query("UPDATE booking.intent_work SET work_worker_id = 'w-hold', work_lease_until = now() + interval '1 minute' WHERE intent_id = $1", [intentId]);
    const preL = await readback(c);
    await expectRaise(c, /E7_23_ACTIVE_WORK_LEASE/); await unchanged(c, preL);
    await c.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [intentId]);
    const op = (await c.query("SELECT id FROM booking.external_operations WHERE state = 'pending' ORDER BY created_at LIMIT 1")).rows[0].id;
    await c.query("UPDATE booking.external_operations SET lease_worker_id = 'w-hold', lease_until = now() + interval '1 minute' WHERE id = $1", [op]);
    const preO = await readback(c);
    await expectRaise(c, /E7_23_OPERATION_LEASED_OR_IN_FLIGHT/); await unchanged(c, preO);
    await c.query("UPDATE booking.external_operations SET lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op]);
    const d = await F.dispatched(pool, { listingId: 772403, from: "2028-06-01", to: "2028-06-04", currency: "USD" });
    assert.ok(await F.claimOp(pool, d.id, "hostaway.create_reservation", F.at(6)), "an accepted in-flight create");
    const preI = await readback(c);
    await expectRaise(c, /E7_23_(ACTIVE_WORK_LEASE|ACTIVE_INTENT_LEASE|OPERATION_LEASED_OR_IN_FLIGHT)/); await unchanged(c, preI);
    assert.equal((await inventory(c)).migrations.max, 21);
  } finally { await B.close(); }
});

test("C3 STOP states, never continued or repaired: schema at 22 (migrator-built) → E7_23_AT_22_STOP; at 23 with an extra function → E7_23_POST_STATE_MISMATCH_STOP; at 23 with a foreign 0023 checksum → STOP:history; a migrator-built 23 IS the exact POST (no-op, nothing written)", async () => {
  const B = await startDbAt(22);
  try { const pre = await readback(B.c); await expectRaise(B.c, /E7_23_AT_22_STOP/); await unchanged(B.c, pre); assert.equal(pre.identity.migrations.max, 22); } finally { await B.close(); }
  const C = await startDbAt(23);
  try {
    const rb = await readback(C.c);
    assert.deepEqual(identity(rb.identity), identity(PINS.post), "migrator-built 23 == pinned POST");
    const r = await runWrapper(C.c); assert.deepEqual(r.notices, ["E7_23_ALREADY_EXACT_NOOP"]); assert.deepEqual(await readback(C.c), rb);
    await C.c.query("CREATE FUNCTION booking._e7_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
    const r1 = await readback(C.c); await expectRaise(C.c, /E7_23_POST_STATE_MISMATCH_STOP:.*functions/); await unchanged(C.c, r1);
    await C.c.query("DROP FUNCTION booking._e7_extra()");
    await C.c.query("UPDATE booking_migrations.applied SET down_checksum = repeat('0',64) WHERE version = 23");
    const r2 = await readback(C.c); await expectRaise(C.c, /E7_23_POST_STATE_MISMATCH_STOP:history/); await unchanged(C.c, r2);
  } finally { await C.close(); }
});

test("C4 atomic rollback: a forced failure at the 0022 tracking row, at the 0023 tracking row, a tampered MID / POST pin, tampered embedded bytes, and a real envelope time-out each leave NOTHING of 0022 / 0023 (columns, functions, table, rows) with data / history unchanged and caller settings preserved", async () => {
  const B = await startDbAt(21);
  try {
    await F.reserved(B.app, { listingId: 772501 });
    const pre = await readback(B.c);
    const gone = async () => (await B.c.query(`SELECT to_regprocedure('booking.claim_guest_notification_v2(uuid,text,text,text,text,text)') IS NULL AS a, to_regclass('booking.notification_provider_receipts') IS NULL AS b,
      NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'booking' AND table_name = 'notification_renders' AND column_name IN ('locale', 'copy_contract_version')) AS c,
      (SELECT count(*)::int FROM booking_migrations.applied WHERE version >= 22) = 0 AS d`)).rows[0];
    for (const v of [22, 23]) {
      await B.c.query(`ALTER TABLE booking_migrations.applied ADD CONSTRAINT _e7_no${v} CHECK (version <> ${v})`);
      await expectRaise(B.c, new RegExp(`_e7_no${v}|check constraint|violates`, "i"));
      await B.c.query(`ALTER TABLE booking_migrations.applied DROP CONSTRAINT _e7_no${v}`);
      assert.deepEqual(await gone(), { a: true, b: true, c: true, d: true }, `failure at ${v}: nothing survives`); await unchanged(B.c, pre);
    }
    // tampered pins: a MID mismatch (after the 0022 up + row) and a POST mismatch (after both ups + rows) each roll EVERYTHING back
    const tamper = (key, re) => { const line = WRAPPER.split("\n").find((l) => l.startsWith(`  ${key} `)); assert.ok(line);
      const t = line.replace(`"functions":"${PINS[key.slice(2)].functions}"`, `"functions":"${"0".repeat(64)}"`); assert.notEqual(t, line); return WRAPPER.replace(line, t); };
    for (const [key, re] of [["c_mid", /E7_23_MID_SCHEMA_IDENTITY_UNEXPECTED:functions/], ["c_post", /E7_23_POST_SCHEMA_IDENTITY_UNEXPECTED:functions/]]) {
      await expectRaise(B.c, re, tamper(key, re));
      assert.deepEqual(await gone(), { a: true, b: true, c: true, d: true }, `${key} mismatch: nothing survives`); await unchanged(B.c, pre);
    }
    const BYTES = WRAPPER.replace("$e7_0023_up$--", "$e7_0023_up$ --"); assert.notEqual(BYTES, WRAPPER);
    await expectRaise(B.c, /E7_23_UP23_BYTES_MISMATCH/, BYTES); assert.deepEqual(await gone(), { a: true, b: true, c: true, d: true }); await unchanged(B.c, pre);
    const SHORT = WRAPPER.replace("SET LOCAL statement_timeout = '180s';", "SET LOCAL statement_timeout = '20ms';"); assert.notEqual(SHORT, WRAPPER);
    await B.c.query("SET statement_timeout = '30s'"); await B.c.query("SET lock_timeout = '7s'");
    let code = null; try { await B.c.query(SHORT); } catch (e) { code = e.code; } assert.equal(code, "57014", "the envelope bound cancels the DO");
    assert.deepEqual([(await B.c.query("SHOW statement_timeout")).rows[0].statement_timeout, (await B.c.query("SHOW lock_timeout")).rows[0].lock_timeout], ["30s", "7s"], "caller settings preserved");
    await B.c.query("RESET statement_timeout"); await B.c.query("RESET lock_timeout");
    assert.deepEqual(await gone(), { a: true, b: true, c: true, d: true }); await unchanged(B.c, pre);
    assert.equal((await B.c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, 0, "no advisory lock left");
    const r = await runWrapper(B.c); assert.equal(r.status.migrations_max, 23, "a clean apply afterwards");
  } finally { await B.close(); }
});

test("C5 disposable-only no-evidence rollback comparison (NEVER an operator shared DOWN): after the wrapper, the merged downs 23 → 21 restore the exact PRE identity with rows unchanged and the wrapper re-applies; the wrapper embeds no down; with a receipt present the 0023 down refuses", async () => {
  const B = await startDbAt(21);
  try {
    await F.reserved(B.app, { listingId: 772601 });
    const pre = await readback(B.c);
    await runWrapper(B.c);
    assert.deepEqual(await migrateDown(B.c, { env: "test", to: 21 }), [23, 22], "disposable only");
    const back = await readback(B.c);
    assert.deepEqual(identity(back.identity), identity(PINS.pre)); assert.deepEqual(back.data, pre.data); assert.deepEqual(back.identity.migrations, pre.identity.migrations);
    assert.deepEqual((await runWrapper(B.c)).notices, ["E7_23_APPLIED"]);
    assert.deepEqual(identity((await readback(B.c)).identity), identity(PINS.post));
    assert.match(m23.down, /MIGRATION_0023_DOWN_REFUSED/); assert.match(m22.down, /MIGRATION_0022_DOWN_REFUSED/);
  } finally { await B.close(); }
});
