// E7 captured-TEST cleanup WORKER (lib/booking-db/cleanup-worker.js) + the 0020 explicit refund settlement, on a throwaway local PostgreSQL with FAKE
// Stripe + Hostaway executors (no network, no SDK, no credentials). Runtime code runs as mv_booking_app; db.owner is used ONLY to tamper leases and to
// write SYNTHETIC rows inside guard tests. Contract: claude/e7-capture-test-cleanup-contract.md rev4.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence, settleOperationFromEvidence } from "../../lib/booking-db/operations.js";
import { requestTestCleanup } from "../../lib/booking-db/test-cleanup.js";
import { runTestCleanupStep, testCleanupWorkerGate, settleRefundFromEvidence, TEST_CLEANUP_EXECUTOR_KEYS, TEST_CLEANUP_WORKER_LIMITS, WORK_STATES, OPS, _internal } from "../../lib/booking-db/cleanup-worker.js";
import { runCleanupStep as runCompensationStep, WORK_STATES as COMPENSATION_STATES } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { migrateUp, migrateDown } from "../../db/lib/migrate.js";
import { refundKey } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const LIST = 606998; const AMT = 576000; const ACCT = "acct_1TestCleanupWorker"; const REF_FIELD = 777004; const TZ = "America/Mazatlan";
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" });
const MIN = F.MIN;
const SHORT = Object.freeze({ readCallMs: 40, writeCallMs: 60 });
const cfg = () => validateAdapterConfig({ allowedListingIds: [LIST], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
const listings = () => new Map([[LIST, { currency: "USD", timeZone: TZ }]]);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode}`), { statusCode });
const state = async (id) => (await loadIntent(db.app, id)).status;
const opsOf = async (id, opType) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, opType])).rows;
const held = async (id) => (await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])) === 1;
const legs = async (id) => { const r = (await db.app.query("SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1", [id])).rows[0]; return [r.c, r.a]; };
const cases = async (id) => (await db.app.query("SELECT kind, status FROM booking.reconciliation_cases WHERE intent_id = $1 ORDER BY opened_at", [id])).rows;
const refundRecord = async (id) => (await db.app.query("SELECT state, stripe_refund_id, amount_minor::text AS amt, hostaway_state FROM booking.payment_refunds WHERE intent_id = $1 AND seq = 1", [id])).rows[0];
const ledger = async (id) => (await db.app.query("SELECT entry, amount_minor::text AS amt, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows;
const reasonOf = async (id) => (await db.app.query("SELECT reason_code, captured_minor::text AS cap FROM booking.intents WHERE id = $1", [id])).rows[0];
const settleLate = (r) => Promise.race([r.late, new Promise((res) => setTimeout(res, 200))]);
const setOpLease = (opId, untilMs, worker = null) => db.owner.query(`UPDATE booking.external_operations SET lease_until = $2${worker ? ", lease_worker_id = $3" : ""} WHERE id = $1`, worker ? [opId, new Date(untilMs), worker] : [opId, new Date(untilMs)]);
const setWorkLease = (intentId, untilMs, worker) => (worker === null
  ? db.owner.query("UPDATE booking.intent_work SET work_lease_until = NULL, work_worker_id = NULL WHERE intent_id = $1", [intentId])
  : db.owner.query("UPDATE booking.intent_work SET work_lease_until = $2, work_worker_id = $3 WHERE intent_id = $1", [intentId, new Date(untilMs), worker]));

// ---------- fake Stripe + Hostaway world (TEST objects; aggregates kept like the provider does) ----------
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), refunds: new Map(), posts: [], cancels: [], signals: [], refundMode: "ok", cancelMode: "ok", piMode: "ok", listMode: "ok",
    accountMode: "ok", retrieveMode: "ok", refundReadMode: "ok", onPiRead: null, onAccount: null, onRefundPost: null, onCancel: null, extraRefunds: [], refundSeq: 0, now: () => Date.now() };
  const hang = (signal) => { w.signals.push(signal); return new Promise(() => {}); };
  w.piObj = (p) => ({ object: "payment_intent", id: p.id, livemode: p.livemode ?? false, status: "succeeded", capture_method: "manual", amount: p.amount, amount_received: p.amount, amount_capturable: 0,
    currency: "usd", metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
    latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: true, amount: p.amount, amount_captured: p.amount,
      amount_refunded: p.refunded, refunded: p.refunded >= p.amount, disputed: p.disputed ?? false, currency: "usd", livemode: p.livemode ?? false, ...(p.chargeExtra || {}) } });
  const mkRefund = (p, params, key, status = "succeeded", created) => {
    w.refundSeq += 1;
    const r = { object: "refund", id: `re_test_${p.id.slice(3)}_${w.refundSeq}`, payment_intent: p.id, charge: p.chargeId, amount: params.amount, currency: "usd", status,
      created: created ?? Math.floor(w.now() / 1000), metadata: { ...params.metadata }, reason: null, failure_reason: null, key };
    w.refunds.set(r.id, r);
    if (status === "succeeded") p.refunded += params.amount;
    return r;
  };
  w.mkRefund = mkRefund;
  const full = (r) => { const o = { id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice, currency: r.currency, status: r.status };
    if (!r.noRef) o.customFieldValues = [{ customFieldId: REF_FIELD, value: r.ref }]; return o; };
  const doCancel = (r) => { r.status = "cancelled"; };
  w.executors = {
    retrieveAccount: async (o = {}) => { w.calls.push("ACCOUNT"); if (w.accountMode === "hang") return hang(o.signal); if (w.onAccount) await w.onAccount(); return { object: "account", id: w.accountMode === "other" ? "acct_1SomeoneElse" : ACCT }; },
    retrievePaymentIntent: async (id, params, o = {}) => {
      assert.deepEqual(params, { expand: ["latest_charge"] }); w.calls.push(`PI ${id}`);
      if (w.onPiRead) await w.onPiRead(id);
      if (w.piMode === "hang") return hang(o.signal);
      if (w.piMode === "500") throw httpError(500);
      return w.piObj(w.pis.get(id));
    },
    createRefund: async (id, params, o = {}) => {
      w.calls.push(`REFUND ${id}`); w.posts.push({ id, params: JSON.parse(JSON.stringify(params)), key: o.idempotencyKey }); w.signals.push(o.signal);
      if (w.onRefundPost) await w.onRefundPost(id);
      const p = w.pis.get(id);
      switch (w.refundMode) {
        case "ok": return mkRefund(p, params, o.idempotencyKey);
        case "pending": return mkRefund(p, params, o.idempotencyKey, "pending");
        case "failed": return mkRefund(p, params, o.idempotencyKey, "failed");
        case "canceled": return mkRefund(p, params, o.idempotencyKey, "canceled");
        case "requires_action": return mkRefund(p, params, o.idempotencyKey, "requires_action");
        case "500": throw httpError(500);
        case "500Applied": mkRefund(p, params, o.idempotencyKey); throw httpError(500);
        case "400": throw httpError(400);
        case "malformed": mkRefund(p, params, o.idempotencyKey); return { object: "refund" };
        case "hang": return hang(o.signal);
        case "hangApplied": mkRefund(p, params, o.idempotencyKey); return hang(o.signal);
        case "late": return new Promise((resolve) => { w.releaseLate = () => resolve(mkRefund(p, params, o.idempotencyKey)); });
        default: throw new Error(w.refundMode);
      }
    },
    retrieveRefund: async (id, o = {}) => {
      w.calls.push(`REFUND_GET ${id}`);
      if (w.refundReadMode === "hang") return hang(o.signal);
      if (w.refundReadMode === "500") throw httpError(500);
      const r = w.refunds.get(id);
      if (!r) throw httpError(404);
      if (w.refundReadMode === "settleNow" && r.status === "pending") { r.status = "succeeded"; w.pis.get(r.payment_intent).refunded += r.amount; }
      return { ...r, metadata: { ...r.metadata } };
    },
    listRefunds: async (pi, params, o = {}) => {
      assert.deepEqual(params, { limit: 100 }); w.calls.push(`REFUND_LIST ${pi}`);
      if (w.listMode === "hang") return hang(o.signal);
      if (w.listMode === "500") throw httpError(500);
      const data = [...w.refunds.values()].filter((r) => r.payment_intent === pi).map((r) => ({ ...r })).concat(w.extraRefunds);
      return { object: "list", url: "/v1/refunds", has_more: w.listMode === "truncated", data };
    },
    retrieveReservation: async (req, o = {}) => {
      w.calls.push(`RES ${req.path}`);
      if (w.retrieveMode === "hang") return hang(o.signal);
      const r = w.res.get(Number(/\/reservations\/(\d+)$/.exec(req.path)[1]));
      if (!r) return { httpStatus: 404, json: { status: "fail" } };
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    lookupPage: async (req) => {
      w.calls.push(`LOOKUP ${req.query.listingId}`);
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map((r) => full({ ...r, noRef: false }));
      return { httpStatus: 200, json: { status: "success", result: items } };
    },
    cancelReservation: async (req, o = {}) => {
      assert.deepEqual(Object.keys(req).sort(), ["body", "method", "path", "query"]);
      assert.equal(req.method, "PUT"); assert.deepEqual(req.body, { cancelledBy: "host" }); assert.deepEqual(req.query, {});
      w.calls.push(`CANCEL ${req.path}`); w.cancels.push(req.path); w.signals.push(o.signal);
      if (w.onCancel) await w.onCancel();
      const r = w.res.get(Number(/\/reservations\/(\d+)\/statuses\/cancelled$/.exec(req.path)[1]));
      switch (w.cancelMode) {
        case "ok": doCancel(r); return { httpStatus: 200, json: { status: "success", result: full(r) } };
        case "replyOnly": return { httpStatus: 200, json: { status: "success", result: { ...full(r), status: "cancelled" } } };
        case "500": return { httpStatus: 500, json: null };
        case "500Cancelled": doCancel(r); return { httpStatus: 500, json: null };
        case "hang": return hang(o.signal);
        case "hangCancelled": doCancel(r); return hang(o.signal);
        default: throw new Error(w.cancelMode);
      }
    }
  };
  w.count = (prefix) => w.calls.filter((c) => c.startsWith(prefix)).length;
  w.forbidden = () => w.calls.filter((c) => /^(VOID|CAPTURE|CREATE|RECORD|NOTIFY)/.test(c)).length;
  return w;
}

// ---------- a CAPTURED TEST payment on 606998 / USD requested for cleanup (the accepted request path) ----------
let stayN = 0;
async function cleanupPending(w, { noRef = false, request = true } = {}) {
  stayN += 1;
  const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-06-01", 3 * stayN), to: F.addDays("2027-06-01", 3 * stayN + 2) };
  const r = await F.reserved(db.app, stay);
  const chargeId = `ch_test_${r.id.replace(/-/g, "").slice(0, 16)}`;
  const op = await F.claimOp(db.app, r.id, OPS.CAPTURE, F.at(8));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: chargeId } }), "capture op");
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
  const i = await loadIntent(db.app, r.id);
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [r.id])).rows[0].id;
  w.pis.set(r.piId, { id: r.piId, intentId: r.id, attemptId: pa, amount: AMT, chargeId, refunded: 0 });
  w.res.set(Number(r.reservationId), { id: Number(r.reservationId), listingMapId: LIST, arrivalDate: stay.from, departureDate: stay.to, totalPrice: 5760, currency: "USD", status: "new", ref: i.ref, noRef });
  const c = { ...r, chargeId, attemptId: pa, intent: i, stay };
  if (request) {
    const operator = Object.freeze({ approvalRef: "SYNTHETIC-cleanup", attemptId: pa, authorizedMinor: i.payment.amountMinor, capturedMinor: i.payment.capturedMinor, chargeId, currency: "USD",
      expectedVersion: i.version, finalTotalMinor: i.price.finalTotalMinor, from: i.from, guests: i.guests, intentId: r.id, listingId: LIST, paymentIntentId: r.piId, planHash: "0".repeat(64),
      reservationId: String(r.reservationId), sessionId: r.sessionId, to: i.to });
    F.ok(await requestTestCleanup(db.app, r.id, { now: F.at(20), env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" }, operator }), "request");
    assert.equal(await state(r.id), "test_cleanup_pending");
  }
  return c;
}
function harness(w, intentId, { start = F.at(30) } = {}) {
  const clk = { t: start };
  w.now = () => clk.t;
  const h = { clk, w,
    // a real clock moves on between a send and its confirming reads; the fake clock does the same (1 s) unless a test installs its own afterSend hook
    opts: (extra = {}) => ({ workerId: "tcw1", env: ENV, adapterConfig: cfg(), listings: listings(), executors: w.executors, clock: () => clk.t, stripeAccountId: ACCT, intentId,
      ...extra, hooks: { afterSend: async () => { clk.t += 1000; }, ...(extra.hooks || {}) } }),
    step: (extra = {}) => runTestCleanupStep(db.app, h.opts(extra)),
    until: async (pred, { max = 30, advanceMs = MIN, extra = {} } = {}) => {
      for (let k = 0; k < max; k++) {
        const st = await state(intentId);
        if (pred(st)) return st;
        const r = await h.step(extra);
        await settleLate(r);
        clk.t += advanceMs;
      }
      assert.fail(`not reached after ${max} steps: ${await state(intentId)} ${JSON.stringify(await _internal.observedFacts(db.app, intentId))}`);
    } };
  return h;
}
const isEnd = (st) => ["cancelled", "reconciliation_required"].includes(st);
/** the exact refund POST the contract pins (§7): FULL captured amount, both metadata fields, Idempotency-Key = ref:<intent>:1 */
function assertExactRefundPost(w, c, opId) {
  assert.equal(w.posts.length, 1, "exactly ONE refund POST");
  assert.deepEqual(w.posts[0], { id: c.piId, params: { amount: AMT, metadata: { mv_refund_op: opId, mv_refund_key: refundKey(c.id, 1) } }, key: refundKey(c.id, 1) });
}

// =============================================================================================
test("gate: disabled by default (both flags + dev/preview), production refused, ONE pinned intent required, listing exactly 606998/USD, exact executor keys, TEST database", async () => {
  const w = world();
  const base = { env: ENV, adapterConfig: cfg(), listings: listings(), executors: w.executors, clock: () => F.at(20), stripeAccountId: ACCT, intentId: "00000000-0000-4000-8000-000000000001" };
  assert.equal(testCleanupWorkerGate(base).ok, true);
  assert.deepEqual([...TEST_CLEANUP_EXECUTOR_KEYS].sort(), ["cancelReservation", "createRefund", "listRefunds", "lookupPage", "retrieveAccount", "retrievePaymentIntent", "retrieveRefund", "retrieveReservation"]);
  assert.deepEqual(WORK_STATES, ["test_cleanup_pending"]);
  assert.ok(!COMPENSATION_STATES.includes("test_cleanup_pending"), "the accepted compensation worker never claims cleanup intents");
  const bad = [
    [{ env: {} }, "ENVIRONMENT_NOT_ALLOWED"], [{ env: { VERCEL_ENV: "production", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled" } }, "PRODUCTION_REFUSED"],
    [{ env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" } }, "NOT_ENABLED"], [{ env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP_WORKER: "enabled" } }, "NOT_ENABLED"],
    [{ env: { VERCEL_ENV: "preview", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "true" } }, "NOT_ENABLED"],
    [{ intentId: null }, "INTENT_ID_REQUIRED"], [{ intentId: "not-a-uuid" }, "INTENT_ID_REQUIRED"], [{ stripeAccountId: "sk_test_x" }, "STRIPE_ACCOUNT_REQUIRED"],
    [{ adapterConfig: { allowedListingIds: [LIST, 890001], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" } }, "LISTING_NOT_ALLOWED"],
    [{ adapterConfig: { allowedListingIds: [890001], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" } }, "LISTING_NOT_ALLOWED"],
    [{ adapterConfig: { allowedListingIds: [LIST], refFieldId: REF_FIELD, channelId: 2000, currency: "MXN" } }, "LISTING_NOT_ALLOWED"],
    [{ listings: new Map([[LIST, { currency: "MXN", timeZone: TZ }]]) }, "LISTING_NOT_ALLOWED"], [{ listings: new Map([[LIST, { currency: "USD", timeZone: "+07:00" }]]) }, "LISTING_TIME_ZONE_INVALID"],
    [{ listings: new Map([[LIST, { currency: "USD", timeZone: TZ }], [890001, { currency: "USD", timeZone: TZ }]]) }, "LISTINGS_REQUIRED"],
    [{ executors: { ...w.executors, capturePaymentIntent: async () => {} } }, "EXECUTOR_NOT_ALLOWED"], [{ executors: { ...w.executors, cancelPaymentIntent: async () => {} } }, "EXECUTOR_NOT_ALLOWED"],
    [{ executors: (({ createRefund, ...rest }) => rest)(w.executors) }, "NO_EXECUTORS"], [{ clock: () => NaN }, "CLOCK_REQUIRED"]
  ];
  for (const [over, code] of bad) assert.equal(testCleanupWorkerGate({ ...base, ...over }).code, code, code);
  const r = await runTestCleanupStep(db.app, { ...base, workerId: "tcw1", env: { ...ENV, MV_E7_TEST_CLEANUP_WORKER: "disabled" } });
  assert.deepEqual([r.status, r.code, w.calls.length], ["refused", "NOT_ENABLED", 0]);
  const r2 = await runTestCleanupStep(db.app, { ...base, workerId: "bad worker id!" });
  assert.deepEqual([r2.status, r2.code], ["refused", "WORKER_ID_INVALID"]);
  const r3 = await runTestCleanupStep(db.app, { ...base, workerId: "tcw1" });
  assert.deepEqual([r3.status, w.calls.length], ["idle", 0], "an unknown pinned intent: nothing claimed, nothing called");
});

test("H1 end-to-end (accepted request → worker): cancel FIRST (one PUT, confirmed by read), then ONE exact refund POST (confirmed by Refund GET + PI read) → both legs proven → cancelled / not_completed_refunded / claim released; zero forbidden sends", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  // step 1: the cancel leg only (the refund leg is not touched while the reservation leg is open)
  const s1 = await h.step(); await settleLate(s1);
  assert.equal(s1.status, "worked");
  assert.deepEqual([w.cancels.length, w.posts.length, w.count("PI "), w.count("ACCOUNT")], [1, 0, 1, 1], JSON.stringify(s1.actions));
  assert.deepEqual([s1.cancelSends, s1.refundSends, s1.sends], [1, 0, 1]);
  assert.equal(w.cancels[0], `/v1/reservations/${c.reservationId}/statuses/cancelled`);
  assert.ok(s1.actions.includes("CANCEL_CLAIMED") && s1.actions.includes("RESERVATION_CANCELLED->test_cleanup_pending"), JSON.stringify(s1.actions));
  assert.deepEqual(await legs(c.id), [true, false]);
  assert.equal(await held(c.id), true, "claim HELD after the first leg");
  const cancelRow = (await opsOf(c.id, OPS.CANCEL))[0];
  assert.deepEqual([cancelRow.state, cancelRow.attempts, cancelRow.result_ref], ["succeeded", 1, String(c.reservationId)]);
  // step 2: the refund leg
  h.clk.t += MIN;
  const s2 = await h.step(); await settleLate(s2);
  assert.equal(s2.status, "worked", JSON.stringify(s2.actions));
  const refundRow = (await opsOf(c.id, OPS.REFUND))[0];
  assertExactRefundPost(w, c, refundRow.id);
  assert.ok(s2.actions.includes("REFUND_CLAIMED") && s2.actions.includes("REFUND_SUCCEEDED->cancelled"), JSON.stringify(s2.actions));
  assert.deepEqual([w.cancels.length, w.posts.length, w.count("REFUND_GET"), w.forbidden()], [1, 1, 1, 0]);
  const re = w.posts.length && [...w.refunds.keys()][0];
  assert.deepEqual([refundRow.state, refundRow.attempts, refundRow.result_ref], ["succeeded", 1, re]);
  assert.equal(await state(c.id), "cancelled");
  assert.deepEqual(await legs(c.id), [true, true]);
  assert.equal(await held(c.id), false, "claim RELEASED only after both proven legs");
  assert.deepEqual(await claimReleaseBlockers(db.app, c.id), []);
  assert.deepEqual(await reasonOf(c.id), { reason_code: "TEST_CLEANUP_REQUESTED", cap: String(AMT) }, "capturedMinor preserved; the truthful reason");
  assert.deepEqual(await refundRecord(c.id), { state: "succeeded", stripe_refund_id: re, amt: String(AMT), hostaway_state: "not_applicable" });
  assert.deepEqual((await ledger(c.id)).map((l) => l.entry), ["authorization_accepted", "capture_succeeded", "refund_succeeded"]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('guest.notify', 'alert.owner', 'stripe.void_payment_intent')", [c.id])).rows[0].n, 0, "nothing notified / voided");
  assert.deepEqual(await cases(c.id), []);
  // evidence: the bound refund read + the fully refunded PI read, API source, after the dispatch
  const ev = (await db.app.query("SELECT kind, status, external_ref FROM booking.provider_evidence WHERE intent_id = $1 AND kind IN ('stripe_refund', 'payment_intent') ORDER BY observed_at, id", [c.id])).rows;
  assert.ok(ev.some((e) => e.kind === "stripe_refund" && e.status === "succeeded" && e.external_ref === re));
  // a further step is idle work: nothing else is ever sent
  h.clk.t += MIN;
  const s3 = await h.step(); await settleLate(s3);
  assert.deepEqual([s3.status, w.cancels.length, w.posts.length], ["idle", 1, 1]);
  assert.deepEqual(s3.facts.settlement, { reservationCancelled: true, authorizationSettled: true });
  assert.equal(s3.facts.claimHeld, false);
  const pub = (await db.app.query("SELECT state FROM booking.intents WHERE id = $1", [c.id])).rows[0].state; assert.equal(pub, "cancelled");
});

test("ORDER invariant: while the cancel leg is open (hung / failed / unknown cancel) NO refund POST is ever sent; the refund leg opens only after the cancel is proven", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  w.cancelMode = "hang";
  const s1 = await h.step({ timeouts: SHORT }); await settleLate(s1);
  assert.deepEqual([w.cancels.length, w.posts.length], [1, 0]);
  assert.ok(s1.actions.includes("RESERVATION_CANCEL_OUTCOME_UNKNOWN:CANCEL_TIMEOUT"), JSON.stringify(s1.actions));
  assert.equal((await opsOf(c.id, OPS.CANCEL))[0].state, "outcome_unknown");
  // the next steps: reads only (≥ dispatch + 2 min), still no refund; the reservation is still active (the hang never applied) → F3 owner case, no second PUT
  for (let k = 0; k < 4; k++) { h.clk.t += MIN; const s = await h.step({ timeouts: SHORT }); await settleLate(s); if (isEnd(await state(c.id))) break; }
  assert.equal(await state(c.id), "reconciliation_required");
  assert.deepEqual([w.cancels.length, w.posts.length, w.forbidden()], [1, 0, 0], "ONE cancel in TOTAL, ZERO refunds");
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [c.id, OPS.CANCEL])).rows[0].n, 1, "no second cancel row (0019 bound)");
  assert.deepEqual((await cases(c.id)).map((x) => x.kind), ["RESERVATION_STILL_ACTIVE_AFTER_CANCEL"]);
  assert.equal(await held(c.id), true);
  assert.deepEqual(await legs(c.id), [false, false]);
  const rf = (await opsOf(c.id, OPS.REFUND))[0]; assert.deepEqual([rf.state, rf.attempts], ["pending", 0], "the refund row was never claimed");
});

test("applied-then-lost cancel (500 after Hostaway cancelled): unknown → no resend → the second session's read proves cancelled → leg settled from evidence; then the refund leg proceeds", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  w.cancelMode = "500Cancelled";
  const s1 = await h.step(); await settleLate(s1);
  assert.ok(s1.actions.includes("RESERVATION_CANCEL_OUTCOME_UNKNOWN:CANCEL_REPLY_NOT_CANCELLED"), JSON.stringify(s1.actions));   // a 500 envelope: no cancelled reply
  w.cancelMode = "ok";                                                                 // even if the provider would now accept: never resent
  const h2 = harness(w, c.id, { start: h.clk.t + MIN });
  await h2.until((st) => st === "cancelled", { max: 12 });
  assert.deepEqual([w.cancels.length, w.posts.length], [1, 1], "ONE cancel + ONE refund in TOTAL across sessions");
  const cancelRow = (await opsOf(c.id, OPS.CANCEL))[0];
  assert.equal(cancelRow.state, "succeeded"); assert.ok(cancelRow.settled_evidence_id, "settled from the cited cancelled read");
  assert.equal(await held(c.id), false);
});

test("lost refund reply (timeout): unknown + REFUND_OUTCOME_UNKNOWN → never resent (same or next session); discovery (exactly one bound refund) → exact GET → 0020 settlement → REFUND_SUCCEEDED → cancelled", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  await settleLate(await h.step());                                                       // one step: the cancel leg
  assert.deepEqual(await legs(c.id), [true, false]);
  w.refundMode = "hangApplied";
  h.clk.t += MIN;
  const s2 = await h.step({ timeouts: SHORT }); await settleLate(s2);
  assert.ok(s2.actions.includes("REFUND_OUTCOME_UNKNOWN:REFUND_TIMEOUT"), JSON.stringify(s2.actions));
  const row = (await opsOf(c.id, OPS.REFUND))[0];
  assert.deepEqual([row.state, row.attempts, w.posts.length], ["outcome_unknown", 1, 1]);
  assert.deepEqual((await refundRecord(c.id)).state, "outcome_unknown");
  w.refundMode = "ok";
  // too early (< dispatch + 2 min): waits, no list, no resend
  h.clk.t += 30 * 1000;
  const s3 = await h.step({ timeouts: SHORT }); await settleLate(s3);
  assert.ok(s3.actions.includes("WAIT:EVIDENCE_FRESHNESS"), JSON.stringify(s3.actions));
  assert.deepEqual([w.posts.length, w.count("REFUND_LIST")], [1, 0]);
  const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
  await h2.until((st) => st === "cancelled", { max: 8, extra: { timeouts: SHORT } });
  assert.deepEqual([w.posts.length, w.count("REFUND_LIST"), w.count("REFUND_GET")], [1, 1, 1], "ONE POST ever; one discovery list; one exact GET");
  const after = (await opsOf(c.id, OPS.REFUND))[0];
  const re = [...w.refunds.keys()][0];
  assert.deepEqual([after.state, after.result_ref, !!after.settled_evidence_id], ["succeeded", re, true], "settled through 0020 from the bound Refund read");
  assert.deepEqual(await refundRecord(c.id), { state: "succeeded", stripe_refund_id: re, amt: String(AMT), hostaway_state: "not_applicable" });
  assert.equal(await held(c.id), false);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [c.id, OPS.REFUND])).rows[0].n, 1, "one_refund_ever");
});

test("discovery refusals after a lost refund: zero refunds → REFUND_NOT_FOUND; several / unbound → REFUND_AMBIGUOUS; has_more → REFUND_LIST_TRUNCATED — each an owner case, NEVER a resend; the refund record stays outcome_unknown", async () => {
  for (const [label, arrange, code] of [
    ["none", (w) => { w.refundMode = "hang"; }, "REFUND_NOT_FOUND"],
    ["two", (w, c) => { w.refundMode = "hangApplied"; w.extraRefunds.push({ object: "refund", id: "re_test_other", payment_intent: c.piId, charge: c.chargeId, amount: AMT, currency: "usd", status: "succeeded", created: Math.floor(F.at(40) / 1000), metadata: {} }); }, "REFUND_AMBIGUOUS"],
    ["unbound metadata", (w, c) => { w.refundMode = "hang"; w.extraRefunds.push({ object: "refund", id: "re_test_foreign", payment_intent: c.piId, charge: c.chargeId, amount: AMT, currency: "usd", status: "succeeded", created: Math.floor(F.at(40) / 1000), metadata: { mv_refund_op: "00000000-0000-4000-8000-00000000dead", mv_refund_key: refundKey(c.id, 1) } }); }, "REFUND_AMBIGUOUS"],
    ["partial amount", (w, c) => { w.refundMode = "hang"; w.extraRefunds.push({ object: "refund", id: "re_test_partial", payment_intent: c.piId, charge: c.chargeId, amount: AMT - 1, currency: "usd", status: "succeeded", created: Math.floor(F.at(40) / 1000), metadata: {} }); }, "REFUND_AMBIGUOUS"],
    ["truncated", (w) => { w.refundMode = "hangApplied"; w.listMode = "truncated"; }, "REFUND_LIST_TRUNCATED"]
  ]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const s1 = await h.step(); await settleLate(s1); assert.deepEqual(await legs(c.id), [true, false], label);
    arrange(w, c);
    h.clk.t += MIN;
    const s2 = await h.step({ timeouts: SHORT }); await settleLate(s2);
    assert.equal((await opsOf(c.id, OPS.REFUND))[0].state, "outcome_unknown", label);
    w.refundMode = "ok";
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until(isEnd, { max: 6, extra: { timeouts: SHORT } });
    assert.equal(await state(c.id), "reconciliation_required", label);
    assert.deepEqual((await cases(c.id)).map((x) => x.kind), [code], label);
    assert.deepEqual([w.posts.length, w.count("REFUND_LIST")], [1, 1], `${label}: ONE POST ever, one list`);
    assert.equal((await refundRecord(c.id)).state, "outcome_unknown", `${label}: the money fact is the owner's to settle with evidence`);
    assert.equal(await held(c.id), true, label);
  }
});

test("refund reply statuses: pending → unknown then the exact GET later shows succeeded (bounded reads, no resend); failed / canceled → REFUND_FAILED owner case; requires_action → reads until the budget is exhausted → owner", async () => {
  // pending → later succeeded
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await h.step(); h.clk.t += MIN; w.refundMode = "pending";
    const s2 = await h.step(); await settleLate(s2);
    assert.ok(s2.actions.includes("REFUND_OUTCOME_UNKNOWN:REFUND_PENDING"), JSON.stringify(s2.actions));
    assert.deepEqual([w.posts.length, w.count("REFUND_GET")], [1, 1]);
    w.refundReadMode = "settleNow";                                                        // the provider settles the pending refund by the time of the next GET
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 8 });
    assert.equal(w.posts.length, 1); assert.equal(await held(c.id), false); }
  // failed / canceled
  for (const mode of ["failed", "canceled"]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await h.step(); h.clk.t += MIN; w.refundMode = mode;
    const s2 = await h.step(); await settleLate(s2);
    assert.ok(s2.actions.includes(`REFUND_FAILED:REFUND_${mode.toUpperCase()}`), JSON.stringify(s2.actions));
    assert.equal(await state(c.id), "reconciliation_required");
    assert.deepEqual((await cases(c.id)).map((x) => x.kind), [`REFUND_${mode.toUpperCase()}`]);
    const row = (await opsOf(c.id, OPS.REFUND))[0]; assert.deepEqual([row.state, row.error_code], ["failed_definite", `REFUND_${mode.toUpperCase()}`]);
    assert.equal((await refundRecord(c.id)).state, "outcome_unknown"); assert.equal(await held(c.id), true); assert.equal(w.posts.length, 1);
  }
  // requires_action: unknown, then bounded GETs that keep showing requires_action → reads exhausted → owner; never a resend
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await h.step(); h.clk.t += MIN; w.refundMode = "requires_action";
    const s2 = await h.step(); await settleLate(s2);
    assert.ok(s2.actions.includes("REFUND_OUTCOME_UNKNOWN:REFUND_REQUIRES_ACTION"), JSON.stringify(s2.actions));
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until(isEnd, { max: 40 });
    assert.equal(await state(c.id), "reconciliation_required");
    assert.deepEqual((await cases(c.id)).map((x) => x.kind), ["CLEANUP_READS_EXHAUSTED"]);
    assert.ok(w.count("REFUND_GET") <= TEST_CLEANUP_WORKER_LIMITS.maxReads[OPS.REFUND_READ], `refund reads bounded: ${w.count("REFUND_GET")}`);
    assert.equal(w.posts.length, 1); }
});

test("strict pre-send proof negatives: an existing refund / partial refund / dispute / refunded flag / foreign charge / live mode / already-cancelled reservation / wrong account → owner case or stop with ZERO cancel PUT and ZERO refund POST", async () => {
  const cancelLegDone = async (w, c, h) => { await h.step(); assert.deepEqual(await legs(c.id), [true, false]); h.clk.t += MIN; };
  const refundCases = [
    ["already refunded (aggregate)", (p) => { p.refunded = AMT; }, "REFUND_PROOF_PI_PROOF_CHARGE_ALREADY_REFUNDED"],       // the v3 evidence proof sees amount_refunded first
    ["partially refunded", (p) => { p.refunded = 100; }, "REFUND_PROOF_PI_PROOF_CHARGE_ALREADY_REFUNDED"],
    ["disputed", (p) => { p.disputed = true; }, "REFUND_PRECONDITION_RAW_CHARGE_DISPUTED"],
    ["refunds list non-empty", (p) => { p.chargeExtra = { refunds: { object: "list", data: [{ id: "re_x" }], has_more: false } }; }, "REFUND_PRECONDITION_RAW_CHARGE_REFUNDS_PRESENT"],
    ["refunded flag missing", (p) => { p.chargeExtra = { refunded: undefined }; }, "REFUND_PRECONDITION_RAW_CHARGE_REFUNDED"],
    ["foreign charge", (p) => { p.chargeId = "ch_test_someoneelse0000"; }, "REFUND_PROOF_PI_PROOF_CHARGE_ID_MISMATCH"]
  ];
  for (const [label, mutate, code] of refundCases) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await cancelLegDone(w, c, h);
    mutate(w.pis.get(c.piId));
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes(`ESCALATE:${code}`), `${label}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.posts.length, await state(c.id), (await opsOf(c.id, OPS.REFUND))[0].state], [0, "reconciliation_required", "pending"], label);
  }
  // live mode on the PI read: the read is unusable (never evidence), nothing claimed
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await cancelLegDone(w, c, h); w.pis.get(c.piId).livemode = true;
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("WAIT:PI_READ_UNUSABLE"), JSON.stringify(s.actions));
    assert.equal(w.posts.length, 0); assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent' AND observed_at >= $2", [c.id, new Date(F.at(30))])).rows[0].n, 1, "only the cancel-leg PI read was recorded"); }
  // cancel-leg negatives: reservation already cancelled externally; wrong Stripe account; a captured PI that is already refunded blocks the cancel too
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.res.get(Number(c.reservationId)).status = "cancelled";
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("ESCALATE:RESERVATION_ALREADY_CANCELLED_EXTERNALLY"), JSON.stringify(s.actions));
    assert.deepEqual([w.cancels.length, w.posts.length], [0, 0]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.accountMode = "other";
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("ESCALATE:STRIPE_ACCOUNT_MISMATCH"), JSON.stringify(s.actions));
    assert.deepEqual([w.cancels.length, w.posts.length], [0, 0]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.pis.get(c.piId).refunded = AMT;
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("ESCALATE:CANCEL_PRECONDITION_RAW_CHARGE_AMOUNT_REFUNDED"), JSON.stringify(s.actions));   // the raw aggregate gate runs first (F3)
    assert.deepEqual([w.cancels.length, w.posts.length], [0, 0]); }
});

test("a reply is never proof: refund 'succeeded' reply whose confirming GET contradicts (other amount) → unknown, no resend; cancel 'cancelled' reply whose read still shows active → unknown, no resend", async () => {
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await h.step(); h.clk.t += MIN;
    const origGet = w.executors.retrieveRefund;
    w.executors.retrieveRefund = async (id, o) => { const r = await origGet(id, o); return { ...r, amount: AMT - 1 }; };
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.some((a) => a.startsWith("REFUND_OUTCOME_UNKNOWN:CONFIRM_REFUND_READ_REFUND_AMOUNT")), JSON.stringify(s.actions));
    assert.deepEqual([(await opsOf(c.id, OPS.REFUND))[0].state, w.posts.length, (await refundRecord(c.id)).state], ["outcome_unknown", 1, "outcome_unknown"]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.cancelMode = "replyOnly";
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("RESERVATION_CANCEL_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CANCELLED"), JSON.stringify(s.actions));
    assert.deepEqual([(await opsOf(c.id, OPS.CANCEL))[0].state, w.cancels.length, w.posts.length], ["outcome_unknown", 1, 0]); }
});

test("stop signal / deadline / step budget: observed after each awaited proof and before every claim or send — nothing new claimed or sent after a stop; facts reported", async () => {
  // abort before the cancel claim: reads happened, zero PUT
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController(); w.onPiRead = async () => { ac.abort(); };
    const s = await h.step({ signal: ac.signal }); await settleLate(s);
    assert.deepEqual([s.status, s.stop && s.stop.code, w.cancels.length, w.posts.length], ["worked", "SIGNAL", 0, 0], JSON.stringify(s.actions));
    assert.ok(s.actions.some((a) => a.startsWith("STOP:SIGNAL:")), JSON.stringify(s.actions));
    assert.deepEqual([s.facts.intentState, s.facts.cancel[0].state, s.facts.refund[0].state, s.facts.claimHeld], ["test_cleanup_pending", "pending", "pending", true]);
    // the next (unsignalled) step continues normally
    h.clk.t += MIN; w.onPiRead = null;
    const s2 = await h.step(); await settleLate(s2); assert.equal(w.cancels.length, 1); }
  // deadline already passed: idle, zero calls
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const s = await h.step({ deadlineAt: F.at(29) }); await settleLate(s);
    assert.deepEqual([s.status, s.stop.code, w.calls.length], ["idle", "DEADLINE", 0]); }
  // deadline reached after the PI read (clock advanced by the read): no claim
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.onPiRead = async () => { h.clk.t += 2 * MIN; };                                        // the read's own 60 s lease expires as well: the read is lost, nothing is claimed
    const s = await h.step({ deadlineAt: F.at(31) }); await settleLate(s);
    assert.equal(w.cancels.length, 0, JSON.stringify(s.actions)); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.onPiRead = async () => { h.clk.t += 30 * 1000; };
    const s = await h.step({ deadlineAt: F.at(30) + 20 * 1000 }); await settleLate(s);
    assert.deepEqual([s.stop.code, w.cancels.length], ["DEADLINE", 0], JSON.stringify(s.actions)); }
  // signal flipped between the claim and the send (pre-send re-check): the claimed row becomes unknown, nothing sent
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController();
    const s = await h.step({ signal: ac.signal, hooks: { afterClaim: async () => { ac.abort(); } } }); await settleLate(s);
    assert.ok(s.actions.includes("SEND_ABORTED:STOP_SIGNAL"), JSON.stringify(s.actions));
    assert.deepEqual([w.cancels.length, (await opsOf(c.id, OPS.CANCEL))[0].state], [0, "outcome_unknown"]); }
});

test("locks / leases / concurrency: a second worker on the same pinned intent is idle (work lease); a tampered operation lease aborts the send (unknown, never sent); a lost work lease blocks the event", async () => {
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    let other;
    const s = await h.step({ hooks: { beforeMaintenance: async () => { other = await runTestCleanupStep(db.app, { ...h.opts(), workerId: "tcw2" }); } } }); await settleLate(s);
    assert.deepEqual([other.status, s.status, w.cancels.length], ["idle", "worked", 1]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const s = await h.step({ hooks: { afterClaim: async (op) => { await setOpLease(op.id, h.clk.t + 1000); } } }); await settleLate(s);
    assert.ok(s.actions.includes("SEND_ABORTED:OPERATION_LEASE_TOO_SHORT"), JSON.stringify(s.actions));
    assert.deepEqual([w.cancels.length, (await opsOf(c.id, OPS.CANCEL))[0].state], [0, "outcome_unknown"]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const s = await h.step({ hooks: { afterClaim: async () => { await setWorkLease(c.id, h.clk.t + 10 * MIN, "someone-else"); } } }); await settleLate(s);
    assert.ok(s.actions.includes("SEND_ABORTED:WORK_LEASE_NOT_HELD"), JSON.stringify(s.actions));
    assert.equal(w.cancels.length, 0);
    await setWorkLease(c.id, h.clk.t - 1, null); }
});

test("void regression / isolation: the accepted compensation worker on a test_cleanup_pending intent is idle (zero calls); the cleanup worker is idle on a non-cleanup state", async () => {
  const w = world(); const c = await cleanupPending(w);
  const comp = await runCompensationStep(db.app, { workerId: "cw1", env: { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" }, adapterConfig: cfg(), listings: listings(),
    executors: { retrieveAccount: w.executors.retrieveAccount, retrievePaymentIntent: w.executors.retrievePaymentIntent, cancelPaymentIntent: async () => assert.fail("void sent"), retrieveReservation: w.executors.retrieveReservation,
      lookupPage: w.executors.lookupPage, cancelReservation: w.executors.cancelReservation }, clock: () => F.at(30), stripeAccountId: ACCT, intentId: c.id });
  assert.deepEqual([comp.status, w.calls.length], ["idle", 0]);
  // a captured intent that was NOT requested for cleanup: idle, untouched
  const w2 = world(); const n = await cleanupPending(w2, { request: false }); const h2 = harness(w2, n.id);
  const s = await h2.step(); assert.deepEqual([s.status, w2.calls.length, await state(n.id)], ["idle", 0, "payment_captured"]);
  // protected reservation ids cannot reach test_cleanup_pending through the accepted request path (requestTestCleanup refuses them; the DB keeps the id
  // immutable), so the worker-level refusal is covered by the pure layer (test/e7-test-cleanup-proof.test.mjs) and the request-level refusal by 0019 Q2.
});

// =============================================================================================
test("0020 settlement API: settle_test_refund_from_evidence settles ONLY the bound refund row from a bound stripe_refund read (too early / mismatch / pending / wrong type refused); the generic function now refuses the refund row explicitly (RED on 0019: it fell through to the cancel branch)", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  await h.step(); h.clk.t += MIN; w.refundMode = "hangApplied";
  await settleLate(await h.step({ timeouts: SHORT }));
  const row = (await opsOf(c.id, OPS.REFUND))[0]; assert.equal(row.state, "outcome_unknown");
  const re = [...w.refunds.keys()][0];
  const read = async (t, over = {}) => {
    const id = await requestRead(db.app, c.id, OPS.REFUND_READ, re, { now: F.at(t) });
    assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: F.at(t), opId: id }));
    F.ok(await completeOperation(db.app, id, { workerId: "w-read", now: F.at(t), outcome: { status: "succeeded" } }));
    const obs = { refundId: re, paymentIntentId: c.piId, chargeId: c.chargeId, amountMinor: AMT, currency: "USD", status: "succeeded", ...over };
    const r = await recordProviderEvidence(db.app, { readOpId: id, kind: "stripe_refund", externalRef: re, status: over.status ?? "succeeded", observed: obs });
    F.ok(r, "evidence"); return r.id;
  };
  const dispatchedMin = (new Date(row.dispatched_at).getTime() - F.T0) / MIN;
  const early = await read(dispatchedMin + 1);
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, early), { ok: false, error: "EVIDENCE_TOO_EARLY" });
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, await read(dispatchedMin + 3, { amountMinor: AMT - 1 })), { ok: false, error: "EVIDENCE_REF_MISMATCH" });
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, await read(dispatchedMin + 4, { chargeId: "ch_test_other0000000000" })), { ok: false, error: "EVIDENCE_REF_MISMATCH" });
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, await read(dispatchedMin + 5, { currency: "MXN" })), { ok: false, error: "EVIDENCE_REF_MISMATCH" });
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, await read(dispatchedMin + 6, { status: "pending" })), { ok: false, error: "EVIDENCE_INCONCLUSIVE" });
  // the accepted generic function: explicit refusal (0020), not the cancel-branch fall-through
  const good = await read(dispatchedMin + 7);
  assert.deepEqual(await settleOperationFromEvidence(db.app, row.id, good), { ok: false, error: "OP_TYPE_NOT_SETTLEABLE" });
  // wrong operation type for the refund settler
  const cancelRow = (await opsOf(c.id, OPS.CANCEL))[0];
  assert.deepEqual(await settleRefundFromEvidence(db.app, cancelRow.id, good), { ok: false, error: "NOT_SETTLEABLE" });
  // the real settlement: succeeded, result_ref = the refund id, settled_evidence_id set once and immutable
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, good), { ok: true, state: "succeeded" });
  const after = (await opsOf(c.id, OPS.REFUND))[0];
  assert.deepEqual([after.state, after.result_ref, after.settled_evidence_id], ["succeeded", re, good]);
  assert.deepEqual(await settleRefundFromEvidence(db.app, row.id, good), { ok: false, error: "NOT_SETTLEABLE" }, "settled once");
  await assert.rejects(db.owner.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [row.id, early]), /SETTLED_EVIDENCE_IMMUTABLE/);
});

test("0020 migration: down restores the 0019 schema exactly; up re-applies identically; settle_operation_from_evidence keeps owner / ACL / security / volatility (body only); the new function is app-executable only", async () => {
  const objects = async (c) => (await c.query(`SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%' ORDER BY 1`)).rows.map((x) => x.o);
  const attrs = async (c) => (await c.query(`SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.provolatile AS vol, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
      coalesce(array_to_string(p.proacl::text[], ','), '') AS acl FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('settle_operation_from_evidence', 'settle_test_refund_from_evidence') ORDER BY 1`)).rows;
  const fresh = await startPostgres(); const c = new pg.Client({ connectionString: fresh.adminUrl }); await c.connect();
  try {
    assert.equal((await migrateUp(c, { env: "test", to: 19 })).at(-1), 19);
    const base19 = await objects(c); const a19 = await attrs(c);
    assert.deepEqual(await migrateUp(c, { env: "test" }), [20]);
    const at20 = await objects(c); const a20 = await attrs(c);
    assert.deepEqual(a20.find((x) => x.sig.startsWith("booking.settle_operation_from_evidence")), a19[0], "replaced function: attributes unchanged");
    const nf = a20.find((x) => x.sig.startsWith("booking.settle_test_refund_from_evidence"));
    assert.ok(nf && nf.secdef === true && /mv_booking_app=X/.test(nf.acl) && !/mv_booking_report|mv_booking_admin/.test(nf.acl), JSON.stringify(nf));
    assert.deepEqual(await migrateDown(c, { env: "test", to: 19 }), [20]);
    assert.deepEqual(await objects(c), base19, "down = 0019 schema exactly");
    assert.deepEqual(await migrateUp(c, { env: "test" }), [20]);
    assert.deepEqual(await objects(c), at20, "up re-applies identically");
    const added = at20.filter((o) => !base19.includes(o)).map((o) => o.split("|").slice(0, 2).join("|"));
    assert.deepEqual(added.sort(), ["fn|booking.settle_operation_from_evidence(uuid,uuid)", "fn|booking.settle_test_refund_from_evidence(uuid,uuid)"]);
  } finally { await c.end(); fresh.stop(); }
});

// =============================================================================================
// ROOT review 5880626183 (HOLD at be8f68d9) — exact reproductions: RED on be8f68d9, GREEN here
test("F1(a) RED→GREEN: outer signal aborted right after retrieveAccount resolves → the PI transport is NEVER invoked (stop noted at the account boundary); pre-aborted signal → idle with zero calls", async () => {
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController(); w.onAccount = async () => { ac.abort(); };
    const s = await h.step({ signal: ac.signal }); await settleLate(s);
    assert.deepEqual([w.calls, s.stop && s.stop.code, w.cancels.length, w.posts.length], [["ACCOUNT"], "SIGNAL", 0, 0], JSON.stringify(s.actions));
    assert.ok(s.actions.includes("STOP:SIGNAL:account_read"), JSON.stringify(s.actions));
    const reads = (await opsOf(c.id, OPS.PI_READ)); assert.deepEqual(reads.map((r) => [r.state, r.attempts, r.error_code]), [["pending", 1, "STOP_SIGNAL"]], "the read row is bookkeeping only (read class: retry later, attempt counted)");
    assert.deepEqual([await state(c.id), await held(c.id)], ["test_cleanup_pending", true]); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController(); ac.abort();
    const s = await h.step({ signal: ac.signal }); await settleLate(s);
    assert.deepEqual([s.status, s.stop.code, w.calls.length], ["idle", "SIGNAL", 0]); }
});

test("F1(b) RED→GREEN: after the refund POST the clock crosses the deadline / the signal aborts → NO refund GET, NO success, NO claim release; row unknown, stop reported; the next session settles it read-only", async () => {
  for (const variant of ["deadline", "signal"]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await settleLate(await h.step()); assert.deepEqual(await legs(c.id), [true, false], variant);
    h.clk.t += MIN;
    const start = h.clk.t; const ac = new AbortController();
    // (the pre-send gate needs whole-call room before the deadline: with the SHORT write timeout the POST is admitted, then the clock crosses the deadline)
    const extra = variant === "deadline" ? { timeouts: SHORT, deadlineAt: start + 500, hooks: { afterSend: async () => { h.clk.t += 1000; } } } : { signal: ac.signal, hooks: { afterSend: async () => { h.clk.t += 1000; ac.abort(); } } };
    const s = await h.step(extra); await settleLate(s);
    assert.equal(w.posts.length, 1, variant);
    assert.deepEqual([w.count("REFUND_GET"), s.stop && s.stop.code, await state(c.id), await held(c.id)], [0, variant === "deadline" ? "DEADLINE" : "SIGNAL", "test_cleanup_pending", true], `${variant}: ${JSON.stringify(s.actions)}`);
    assert.ok(s.actions.some((a) => a.startsWith("REFUND_OUTCOME_UNKNOWN:STOP_")), `${variant}: ${JSON.stringify(s.actions)}`);
    const row = (await opsOf(c.id, OPS.REFUND))[0]; assert.deepEqual([row.state, row.attempts], ["outcome_unknown", 1], variant);
    assert.deepEqual(await legs(c.id), [true, false], variant);
    assert.deepEqual(s.facts.refund[0].state, "outcome_unknown");
    // a fresh session (no stop) settles it from the exact GET after discovery; still ONE POST ever
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 8 });
    assert.deepEqual([w.posts.length, w.count("REFUND_LIST"), await held(c.id)], [1, 1, false], variant);
  }
  // with the default write timeout the pre-send gate needs whole-call room before the deadline: the POST is never admitted (zero sends, row unknown, stop reported)
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await settleLate(await h.step()); h.clk.t += MIN;
    const s = await h.step({ deadlineAt: h.clk.t + 500 }); await settleLate(s);
    assert.ok(s.actions.includes("SEND_ABORTED:STOP_DEADLINE"), JSON.stringify(s.actions));
    assert.deepEqual([w.posts.length, s.stop.code, (await opsOf(c.id, OPS.REFUND))[0].state], [0, "DEADLINE", "outcome_unknown"]); }
});

test("F1 boundaries: a reply that resolves at / after the deadline is inadmissible (read row unknown, no claim); a provider rejection after a stop is reported as the stop, not as a provider failure; stop between claim and send → unknown without a PUT", async () => {
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.onPiRead = async () => { h.clk.t += 30 * 1000; };
    const s = await h.step({ deadlineAt: F.at(30) + 20 * 1000 }); await settleLate(s);
    assert.deepEqual([s.stop.code, w.cancels.length, w.posts.length], ["DEADLINE", 0, 0], JSON.stringify(s.actions));
    assert.ok(s.actions.includes("STOP:DEADLINE:pi_read"), JSON.stringify(s.actions));
    assert.deepEqual((await opsOf(c.id, OPS.PI_READ)).map((r) => [r.state, r.attempts, r.error_code]), [["pending", 1, "STOP_DEADLINE"]], "the inadmissible reply is bookkeeping only"); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController(); w.piMode = "500"; w.onPiRead = async () => { ac.abort(); };
    const s = await h.step({ signal: ac.signal }); await settleLate(s);
    assert.deepEqual([s.stop.code, w.cancels.length], ["SIGNAL", 0]);
    assert.ok(s.actions.includes("STOP:SIGNAL:pi_read") && !s.actions.includes("WAIT:PI_READ_FAILED"), JSON.stringify(s.actions)); }
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController();
    const s = await h.step({ signal: ac.signal, hooks: { afterClaim: async () => { ac.abort(); } } }); await settleLate(s);
    assert.deepEqual([w.cancels.length, (await opsOf(c.id, OPS.CANCEL))[0].state, s.stop.code], [0, "outcome_unknown", "SIGNAL"], JSON.stringify(s.actions)); }
  // the cancel send itself: signal aborted while the PUT is in flight → the (applied) cancel is uncertain; no confirming read, no success; the next session proves it read-only
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController(); w.onCancel = async () => { ac.abort(); };
    const s = await h.step({ signal: ac.signal }); await settleLate(s);
    assert.deepEqual([w.cancels.length, (await opsOf(c.id, OPS.CANCEL))[0].state, s.stop.code, w.count("RES ")], [1, "outcome_unknown", "SIGNAL", 1], JSON.stringify(s.actions));
    assert.ok(s.actions.includes("RESERVATION_CANCEL_OUTCOME_UNKNOWN:STOP_SIGNAL_AFTER_SEND"), JSON.stringify(s.actions));
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 10 });
    assert.deepEqual([w.cancels.length, w.posts.length], [1, 1]); }
});

test("F2 RED→GREEN: ONE persisted read-budget admission for new AND reused pending / retried reads across sessions — unknown refund + PI 500s over 14 steps: SUM(attempts) ≤ 8, then a bounded owner case; no claim at the ceiling", async () => {
  const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
  await settleLate(await h.step()); assert.deepEqual(await legs(c.id), [true, false]);
  h.clk.t += MIN; w.refundMode = "hangApplied";
  await settleLate(await h.step({ timeouts: SHORT }));
  assert.equal((await opsOf(c.id, OPS.REFUND))[0].state, "outcome_unknown");
  w.refundMode = "ok"; w.piMode = "500";
  const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
  for (let k = 0; k < 14; k++) { const s = await h2.step({ timeouts: SHORT }); await settleLate(s); h2.clk.t += MIN; }
  const used = Number((await db.app.query("SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'", [c.id, OPS.PI_READ])).rows[0].n);
  assert.ok(used <= TEST_CLEANUP_WORKER_LIMITS.maxReads[OPS.PI_READ], `persisted PI-read attempts ${used} ≤ ${TEST_CLEANUP_WORKER_LIMITS.maxReads[OPS.PI_READ]}`);
  assert.equal(await state(c.id), "reconciliation_required");
  assert.deepEqual((await cases(c.id)).map((x) => x.kind), ["CLEANUP_READS_EXHAUSTED"]);
  assert.deepEqual([w.posts.length, w.count("REFUND_LIST")], [1, 0], "never resent; no discovery without a PI read");
  // the ceiling holds for the OTHER read kinds too (the Hostaway by-id read of an unknown cancel through the reused E3 row)
  const w2 = world(); const c2 = await cleanupPending(w2); const g = harness(w2, c2.id);
  w2.cancelMode = "hangCancelled";
  await settleLate(await g.step({ timeouts: SHORT }));
  assert.equal((await opsOf(c2.id, OPS.CANCEL))[0].state, "outcome_unknown");
  w2.cancelMode = "ok"; w2.retrieveMode = "hang";
  const g2 = harness(w2, c2.id, { start: g.clk.t + 3 * MIN });
  for (let k = 0; k < 20; k++) { const s = await g2.step({ timeouts: SHORT }); await settleLate(s); g2.clk.t += MIN; if (isEnd(await state(c2.id))) break; }
  const usedRes = Number((await db.app.query("SELECT coalesce(sum(attempts), 0) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read'", [c2.id, OPS.RES_READ])).rows[0].n);
  assert.ok(usedRes <= TEST_CLEANUP_WORKER_LIMITS.maxReads[OPS.RES_READ], `Hostaway reads ${usedRes}`);
  assert.deepEqual([await state(c2.id), w2.cancels.length, w2.posts.length], ["reconciliation_required", 1, 0]);
});

test("F3 RED→GREEN: a disputed PI, an existing refund in the charge's refunds list, a partial refund or a missing required flag on the INITIAL step → owner case with ZERO cancel PUT and ZERO refund POST; the cancel row stays pending (never admitted)", async () => {
  for (const [label, mutate, code] of [
    ["disputed", (p) => { p.disputed = true; }, "CANCEL_PRECONDITION_RAW_CHARGE_DISPUTED"],
    ["refunds list non-empty", (p) => { p.chargeExtra = { refunds: { object: "list", has_more: false, data: [{ id: "re_external999" }] } }; }, "CANCEL_PRECONDITION_RAW_CHARGE_REFUNDS_PRESENT"],
    ["partial refund", (p) => { p.refunded = 100; }, "CANCEL_PRECONDITION_RAW_CHARGE_AMOUNT_REFUNDED"],
    ["refunded flag missing", (p) => { p.chargeExtra = { refunded: undefined }; }, "CANCEL_PRECONDITION_RAW_CHARGE_REFUNDED"],
    ["disputed flag missing", (p) => { p.chargeExtra = { disputed: undefined }; }, "CANCEL_PRECONDITION_RAW_CHARGE_DISPUTED"],
    ["dispute object present", (p) => { p.chargeExtra = { dispute: "dp_test_1" }; }, "CANCEL_PRECONDITION_RAW_CHARGE_DISPUTE_PRESENT"]]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    mutate(w.pis.get(c.piId));
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes(`ESCALATE:${code}`), `${label}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.cancels.length, w.posts.length, await state(c.id), (await opsOf(c.id, OPS.CANCEL))[0].state, (await opsOf(c.id, OPS.CANCEL))[0].attempts], [0, 0, "reconciliation_required", "pending", 0], label);
    assert.equal(await held(c.id), true, label);
  }
});

test("residuals: equal-timestamp PI observations fail CLOSED (recorded, not used; reads later); INITIAL cancellation needs a strictly future arrival in the listing zone, but a past arrival never blocks read-only settlement of the worker's own cancel or the refund leg", async () => {
  // tie: two reconcile steps at the SAME business clock → the second PI observation ties the first → fails CLOSED (recorded, not used; no GET, no settlement); a later clock resolves
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await settleLate(await h.step()); assert.deepEqual(await legs(c.id), [true, false]);
    h.clk.t += MIN; w.refundMode = "hangApplied";
    await settleLate(await h.step({ timeouts: SHORT }));                                // PI read (pre-send), POST hangs after applying → unknown
    assert.equal((await opsOf(c.id, OPS.REFUND))[0].state, "outcome_unknown");
    w.refundMode = "ok"; w.refundReadMode = "500";
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    const a = await h2.step(); await settleLate(a);                                     // PI read at t2, discovery, exact GET fails → waiting
    assert.ok(a.actions.includes("DISCOVERED:succeeded") && a.actions.includes("READ!REFUND_READ_FAILED"), JSON.stringify(a.actions));
    const b = await h2.step(); await settleLate(b);                                     // SAME clock: the new PI observation ties → no list, no GET, no settlement
    assert.ok(b.actions.includes("READ!PI_OBSERVATION_TIE"), JSON.stringify(b.actions));
    assert.deepEqual([w.count("REFUND_LIST"), w.count("REFUND_GET"), await state(c.id)], [1, 1, "test_cleanup_pending"]);
    assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent' AND observed_at = $2", [c.id, new Date(h2.clk.t)])).rows[0].n, 2, "both observations are recorded; neither is used");
    w.refundReadMode = "ok"; h2.clk.t += MIN;
    await h2.until((st) => st === "cancelled", { max: 6 });
    assert.equal(w.posts.length, 1); }
  // arrival in the past at the INITIAL step: refused before any read of the reservation, zero PUT / POST
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id, { start: Date.UTC(2028, 0, 15, 18, 0, 0) });
    const s = await h.step(); await settleLate(s);
    assert.ok(s.actions.includes("ESCALATE:CANCEL_ARRIVAL_NOT_IN_FUTURE"), JSON.stringify(s.actions));
    assert.deepEqual([w.cancels.length, w.posts.length, w.count("RES "), await state(c.id)], [0, 0, 0, "reconciliation_required"]); }
  // the arrival passes AFTER this worker's own uncertain cancel: read-only settlement and the refund leg still complete (no arrival gate there)
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    w.cancelMode = "hangCancelled";
    await settleLate(await h.step({ timeouts: SHORT }));
    assert.equal((await opsOf(c.id, OPS.CANCEL))[0].state, "outcome_unknown");
    const h2 = harness(w, c.id, { start: Date.UTC(2028, 0, 15, 18, 0, 0) });            // the stay is long past
    await h2.until((st) => st === "cancelled", { max: 10 });
    assert.deepEqual([w.cancels.length, w.posts.length, await held(c.id)], [1, 1, false]); }
});

// =============================================================================================
// ROOT re-review 5880873025 (HOLD at 1bd2fcf7) — R1 / R2 exact reproductions: RED on 1bd2fcf7, GREEN here
const piEvidenceCount = async (id) => (await db.app.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent'", [id])).rows[0].n;
const evidenceCount = async (id, kind) => (await db.app.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1 AND kind = $2", [id, kind])).rows[0].n;

test("R1(A) RED→GREEN: signal / deadline stop right AFTER the refund row completed (afterComplete) → NO REFUND_SUCCEEDED, NO claim release, stop reported; the durable succeeded row is preserved and the next session finishes WITHOUT a second POST", async () => {
  for (const mode of ["signal", "deadline"]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    await settleLate(await h.step()); h.clk.t += MIN;
    const ac = new AbortController(); const deadline = h.clk.t + 30000;
    const s = await h.step({ signal: ac.signal, deadlineAt: mode === "deadline" ? deadline : null,
      hooks: { afterSend: async () => { h.clk.t += 1000; }, afterComplete: async (op) => { if (op.op_type === OPS.REFUND) { if (mode === "signal") ac.abort(); else h.clk.t = deadline; } } } });
    await settleLate(s);
    const row = (await opsOf(c.id, OPS.REFUND))[0];
    assert.deepEqual([await state(c.id), await held(c.id), s.stop && s.stop.code, row.state, !!row.result_ref, w.posts.length], ["test_cleanup_pending", true, mode === "signal" ? "SIGNAL" : "DEADLINE", "succeeded", true, 1], `${mode}: ${JSON.stringify(s.actions)}`);
    assert.ok(s.actions.includes("REFUND_ROW_SUCCEEDED_EVENT_DEFERRED") && !s.actions.some((a) => a.startsWith("REFUND_SUCCEEDED->")), `${mode}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual(await legs(c.id), [true, false], mode);
    assert.deepEqual([s.facts.refund[0].state, s.facts.claimHeld], ["succeeded", true], `${mode}: honest facts — the committed row, the held claim`);
    // next session (no stop): the succeeded row's own refund id is read again (exact GET + PI read) → REFUND_SUCCEEDED → cancelled; ONE POST ever
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 6 });
    assert.deepEqual([w.posts.length, w.count("REFUND_LIST"), await held(c.id)], [1, 0, false], `${mode}: proven from the known id, no discovery, no resend`);
  }
  // the cancel completion has the same boundary
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    const ac = new AbortController();
    const s = await h.step({ signal: ac.signal, hooks: { afterComplete: async (op) => { if (op.op_type === OPS.CANCEL) ac.abort(); } } }); await settleLate(s);
    const row = (await opsOf(c.id, OPS.CANCEL))[0];
    assert.deepEqual([await legs(c.id), s.stop.code, row.state, w.cancels.length], [[false, false], "SIGNAL", "succeeded", 1], JSON.stringify(s.actions));
    assert.ok(s.actions.includes("CANCEL_ROW_SUCCEEDED_EVENT_DEFERRED"), JSON.stringify(s.actions));
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 8 });
    assert.deepEqual([w.cancels.length, w.posts.length, await held(c.id)], [1, 1, false]); }
});

test("R1(B) RED→GREEN: the stop arrives DURING the success transaction's own proof query (real client, abort before the evidence count returns) → the event is vetoed and rolled back: intent / claim untouched, stop reported; next session finishes without resend", async () => {
  for (const [label, needle, opType] of [["refund", "e.source = 'stripe_api'", OPS.REFUND], ["cancel", "e.kind = 'hostaway_reservation'", OPS.CANCEL]]) {
    const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id);
    if (label === "refund") { await settleLate(await h.step()); h.clk.t += MIN; }
    const ac = new AbortController();
    const origConnect = db.app.connect.bind(db.app);
    const wrap = (client) => {
      const q = client.query.bind(client);
      client.query = async (...qa) => { const r = await q(...qa); if (typeof qa[0] === "string" && qa[0].includes(needle) && qa[0].includes("count(*)")) ac.abort(); return r; };
      return client;
    };
    // pg Pool.connect: promise form (the repo's transactions) and callback form (pool.query internally) both wrapped
    db.app.connect = (cb) => (typeof cb === "function" ? origConnect((err, client, release) => cb(err, client ? wrap(client) : client, release)) : origConnect().then(wrap));
    let s;
    try { s = await h.step({ signal: ac.signal }); await settleLate(s); } finally { db.app.connect = origConnect; }
    const row = (await opsOf(c.id, opType))[0];
    assert.equal(ac.signal.aborted, true, `${label}: the abort fired inside the transaction`);
    assert.deepEqual([await state(c.id), await held(c.id), s.stop && s.stop.code, row.state], ["test_cleanup_pending", true, "SIGNAL", "succeeded"], `${label}: ${JSON.stringify(s.actions)}`);
    assert.ok(s.actions.some((a) => a.endsWith("!STOPPED")), `${label}: the event was vetoed inside its transaction: ${JSON.stringify(s.actions)}`);
    assert.deepEqual(await legs(c.id), label === "refund" ? [true, false] : [false, false], label);
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 8 });
    assert.deepEqual([w.cancels.length, w.posts.length, await held(c.id)], [1, 1, false], label);
  }
});

test("R2 RED→GREEN: a stop inside read post-processing (after*Read hooks) never persists authoritative evidence — PI, Hostaway and refund reads take the STOP_* bookkeeping path; a late tie / unusable reply keeps the fixed stop code", async () => {
  // PI read on the initial step (exact ROOT repro): evidence count 0 → 0, read row attempts 1 with STOP_SIGNAL, no claim
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id); const ac = new AbortController();
    const before = await piEvidenceCount(c.id);
    const s = await h.step({ signal: ac.signal, hooks: { afterPiRead: async () => ac.abort() } }); await settleLate(s);
    assert.deepEqual([before, await piEvidenceCount(c.id), s.stop.code, w.cancels.length], [0, 0, "SIGNAL", 0], JSON.stringify(s.actions));
    assert.deepEqual((await opsOf(c.id, OPS.PI_READ)).map((r) => [r.state, r.attempts, r.error_code]), [["pending", 1, "STOP_SIGNAL"]]);
    assert.ok(s.actions.includes("STOP:SIGNAL:pi_read"), JSON.stringify(s.actions)); }
  // Hostaway by-id read
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id); const ac = new AbortController();
    const s = await h.step({ signal: ac.signal, hooks: { afterResRead: async () => ac.abort() } }); await settleLate(s);
    assert.deepEqual([await evidenceCount(c.id, "hostaway_reservation"), s.stop.code, w.cancels.length], [0, "SIGNAL", 0], JSON.stringify(s.actions));
    assert.deepEqual((await opsOf(c.id, OPS.RES_READ)).map((r) => [r.state, r.attempts, r.error_code]), [["pending", 1, "STOP_SIGNAL"]]); }
  // refund GET after the POST: no stripe_refund evidence, row unknown (uncertainty bookkeeping), no success; the next session proves it read-only
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id); const ac = new AbortController();
    await settleLate(await h.step()); h.clk.t += MIN;
    const s = await h.step({ signal: ac.signal, hooks: { afterRefundRead: async () => ac.abort() } }); await settleLate(s);
    assert.deepEqual([await evidenceCount(c.id, "stripe_refund"), s.stop.code, (await opsOf(c.id, OPS.REFUND))[0].state, await state(c.id), await held(c.id)], [0, "SIGNAL", "outcome_unknown", "test_cleanup_pending", true], JSON.stringify(s.actions));
    assert.ok(s.actions.includes("REFUND_OUTCOME_UNKNOWN:STOP_SIGNAL_AFTER_SEND"), JSON.stringify(s.actions));
    const h2 = harness(w, c.id, { start: h.clk.t + 3 * MIN });
    await h2.until((st) => st === "cancelled", { max: 8 });
    assert.deepEqual([w.posts.length, await held(c.id)], [1, false]); }
  // the stop code stays fixed even when the reply is also unusable (live-mode PI) — the stop is reported, no evidence, no claim
  { const w = world(); const c = await cleanupPending(w); const h = harness(w, c.id); const ac = new AbortController();
    w.pis.get(c.piId).livemode = true;
    const s = await h.step({ signal: ac.signal, hooks: { afterPiRead: async () => ac.abort() } }); await settleLate(s);
    assert.deepEqual([await piEvidenceCount(c.id), s.stop.code], [0, "SIGNAL"]);
    assert.ok(s.actions.includes("STOP:SIGNAL:pi_read") && !s.actions.includes("WAIT:PI_READ_UNUSABLE"), JSON.stringify(s.actions)); }
});
