// E7 recorded TEST cleanup — the Hostaway offline-refund MIRROR worker (lib/booking-db/mirror-worker.js) + pure proofs (lib/checkout/mirror-proof.js) on
// a throwaway local PostgreSQL with FAKE Stripe + Hostaway executors (no network, no SDK, no credentials). Runtime code runs as mv_booking_app; db.owner
// is used ONLY to tamper leases in the lease tests. The cancel + Stripe refund legs are worked by the EXISTING cleanup worker (unchanged); the mirror
// worker only takes over once both are proven. Real clock for the mirror worker (0021 proof freshness is judged by the DATABASE clock).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence, completeRecordingWithEvidence } from "../../lib/booking-db/operations.js";
import { requestRecordedTestCleanup } from "../../lib/booking-db/test-cleanup-recorded.js";
import { runTestCleanupStep } from "../../lib/booking-db/cleanup-worker.js";
import { runMirrorStep, mirrorWorkerGate, MIRROR_EXECUTOR_KEYS, OPS, _internal } from "../../lib/booking-db/mirror-worker.js";
import { offlineChargeTitle } from "../../lib/checkout/offline-charge-proof.js";
import { mirrorTitle } from "../../lib/checkout/mirror-proof.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const LIST = 606998; const AMT = 576000; const ACCT = "acct_1TestMirrorWorker"; const REF_FIELD = 777004; const TZ = "America/Mazatlan";
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled", MV_E7_TEST_CLEANUP_WORKER: "enabled", MV_E7_MIRROR_WORKER: "enabled" });
const cfg = () => validateAdapterConfig({ allowedListingIds: [LIST], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" });
const recCfg = () => ({ accountRef: F.PREFLIGHT_ACCOUNT_REF, channelId: 2000, currency: "USD", listingId: LIST, paymentMethod: "credit_card", refFieldId: REF_FIELD });
const listings = () => new Map([[LIST, { currency: "USD", timeZone: TZ }]]);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode}`), { statusCode });
const state = async (id) => (await loadIntent(db.app, id)).status;
const opsOf = async (id, opType) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, opType])).rows;
const held = async (id) => (await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])) === 1;
const flags = async (id) => { const r = (await db.app.query("SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a, settlement_recording_mirrored AS m FROM booking.intents WHERE id = $1", [id])).rows[0]; return [r.c, r.a, r.m]; };
const cases = async (id) => (await db.app.query("SELECT kind, status FROM booking.reconciliation_cases WHERE intent_id = $1 ORDER BY opened_at", [id])).rows;
const ledger = async (id) => (await db.app.query("SELECT entry, amount_minor::text AS amt, provider, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows;
const endOk = async (id) => (await db.app.query("SELECT booking.recorded_state_cleanup_ok($1) AS ok", [id])).rows[0].ok;
const transitions = async (id) => (await db.app.query("SELECT from_state, to_state, event_type FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY id", [id])).rows;
/** scheduling only (test harness): a worker's release pushes next_action_at ~30 s ahead; make the intent due now for the next worker step */
const due = (id, atMs = Date.now()) => db.owner.query("UPDATE booking.intent_work SET next_action_at = $2 WHERE intent_id = $1", [id, new Date(atMs)]);
const settleLate = (r) => (r && r.late ? Promise.race([r.late, new Promise((res) => setTimeout(res, 200))]) : Promise.resolve());

// ---------- fake Stripe + Hostaway world (TEST objects; the charge list behaves like the documented refund facts) ----------
let chargeSeq = 700000;                                                                    // provider-unique ids across worlds (like the real provider)
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), refunds: new Map(), posts: [], cancels: [], mirrorPosts: [], charges: new Map(), refundSeq: 0,
    refundMode: "ok", cancelMode: "ok", piMode: "ok", accountMode: "ok", retrieveMode: "ok", listMode: "ok", mirrorMode: "ok", onMirrorPost: null, onList: null, now: () => Date.now() };
  const hang = (signal) => new Promise(() => { void signal; });
  w.piObj = (p) => ({ object: "payment_intent", id: p.id, livemode: false, status: "succeeded", capture_method: "manual", amount: p.amount, amount_received: p.amount, amount_capturable: 0,
    currency: "usd", metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
    latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: true, amount: p.amount, amount_captured: p.amount,
      amount_refunded: p.refunded, refunded: p.refunded >= p.amount, disputed: false, currency: "usd", livemode: false } });
  const mkRefund = (p, params, key, status = "succeeded") => {
    w.refundSeq += 1;
    const r = { object: "refund", id: `re_test_${p.id.slice(3)}_${w.refundSeq}`, payment_intent: p.id, charge: p.chargeId, amount: params.amount, currency: "usd", status,
      created: Math.floor(w.now() / 1000), metadata: { ...params.metadata }, reason: null, failure_reason: null, key };
    w.refunds.set(r.id, r); if (status === "succeeded") p.refunded += params.amount; return r;
  };
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: r.channelId ?? 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice, currency: r.currency, status: r.status,
    customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  const rowsOf = (rid) => w.charges.get(Number(rid)) || [];
  w.addRefundRow = (rid, over = {}) => {
    const rows = rowsOf(rid); const orig = rows.find((x) => x.type === "charge");
    chargeSeq += 1;
    const row = { id: chargeSeq, reservationId: Number(rid), listingMapId: LIST, type: "refund", title: over.title ?? mirrorTitle(orig.intentId), amount: over.amount ?? -orig.amount, currency: "USD",
      status: over.status ?? "succeeded", paymentProvider: over.paymentProvider ?? "offline", paymentMethod: "credit_card",
      refundInfo: over.refundInfo === null ? undefined : (over.refundInfo ?? { id: chargeSeq + 1000000, chargeId: chargeSeq, refundedChargeId: orig.id }) };
    if (over.refundInfo === null) delete row.refundInfo;
    rows.push(row); w.charges.set(Number(rid), rows); return row;
  };
  w.executors = {
    retrieveAccount: async (o = {}) => { w.calls.push("ACCOUNT"); if (w.accountMode === "hang") return hang(o.signal); return { object: "account", id: w.accountMode === "other" ? "acct_1SomeoneElse" : ACCT }; },
    retrievePaymentIntent: async (id, params, o = {}) => { assert.deepEqual(params, { expand: ["latest_charge"] }); w.calls.push(`PI ${id}`); if (w.piMode === "hang") return hang(o.signal); if (w.piMode === "500") throw httpError(500); return w.piObj(w.pis.get(id)); },
    createRefund: async (id, params, o = {}) => { w.calls.push(`REFUND ${id}`); w.posts.push({ id, params: JSON.parse(JSON.stringify(params)), key: o.idempotencyKey }); return mkRefund(w.pis.get(id), params, o.idempotencyKey); },
    retrieveRefund: async (id) => { w.calls.push(`REFUND_GET ${id}`); const r = w.refunds.get(id); if (!r) throw httpError(404); return { ...r, metadata: { ...r.metadata } }; },
    listRefunds: async (pi) => { w.calls.push(`REFUND_LIST ${pi}`); return { object: "list", url: "/v1/refunds", has_more: false, data: [...w.refunds.values()].filter((r) => r.payment_intent === pi) }; },
    retrieveReservation: async (req, o = {}) => {
      w.calls.push(`RES ${req.path}`); if (w.retrieveMode === "hang") return hang(o.signal);
      const r = w.res.get(Number(/\/reservations\/(\d+)$/.exec(req.path)[1]));
      if (!r) return { httpStatus: 404, json: { status: "fail" } };
      return { httpStatus: 200, json: { status: "success", result: full(r) } };
    },
    lookupPage: async (req) => { w.calls.push(`LOOKUP ${req.query.listingId}`); const items = req.query.afterId ? [] : [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full); return { httpStatus: 200, json: { status: "success", result: items } }; },
    cancelReservation: async (req) => { w.calls.push(`CANCEL ${req.path}`); w.cancels.push(req.path); const r = w.res.get(Number(/\/reservations\/(\d+)\/statuses\/cancelled$/.exec(req.path)[1])); r.status = "cancelled"; return { httpStatus: 200, json: { status: "success", result: full(r) } }; },
    listOfflineCharges: async (req, o = {}) => {
      assert.deepEqual(Object.keys(req).sort(), ["method", "path", "query"]); assert.equal(req.method, "GET"); assert.equal(req.path, "/v1/guestPayments/charges"); assert.equal(req.query.limit, 500);
      w.calls.push(`LIST ${req.query.reservationId}`);
      if (w.onList) await w.onList();
      if (w.listMode === "hang") return hang(o.signal);
      if (w.listMode === "500") return { httpStatus: 500, json: null };
      const rows = rowsOf(req.query.reservationId).map((x) => JSON.parse(JSON.stringify(x)));
      return { httpStatus: 200, json: { status: "success", result: rows, count: rows.length, limit: 500 } };
    },
    refundOfflineCharge: async (req, o = {}) => {
      assert.deepEqual(Object.keys(req).sort(), ["body", "method", "path", "query"]); assert.equal(req.method, "POST"); assert.deepEqual(req.query, {});
      w.calls.push(`MIRROR ${req.path}`); w.mirrorPosts.push({ path: req.path, body: JSON.parse(JSON.stringify(req.body)) });
      if (w.onMirrorPost) await w.onMirrorPost();
      const m = /\/v1\/guestPayments\/charges\/(\d+)\/(\d+)\/refund$/.exec(req.path);
      const rid = m[1]; const och = m[2];
      const reply = (row, over = {}) => ({ httpStatus: 200, json: { status: "success", result: { id: row.id, refundInfo: { ...row.refundInfo }, status: "succeeded", paymentProvider: "offline", ...over } } });
      switch (w.mirrorMode) {
        case "ok": return reply(w.addRefundRow(rid));
        case "partial": return reply(w.addRefundRow(rid, { amount: -2000 }));                       // provider refunded less than asked: the LIST contradicts the reply
        case "inverted": { const row = w.addRefundRow(rid); return reply(row, { refundInfo: { id: row.refundInfo.id, chargeId: Number(och), refundedChargeId: row.id } }); }
        case "noLinkRow": { const row = w.addRefundRow(rid, { refundInfo: null }); return reply(row, { refundInfo: { id: 1, chargeId: row.id, refundedChargeId: Number(och) } }); }
        case "foreignLink": { const row = w.addRefundRow(rid, { refundInfo: { id: 5, chargeId: chargeSeq + 1, refundedChargeId: Number(och) + 1 } }); return reply(row); }
        case "pendingStatus": return reply(w.addRefundRow(rid, { status: "pending" }), { status: "pending" });
        case "500": return { httpStatus: 500, json: null };
        case "500Applied": w.addRefundRow(rid); return { httpStatus: 500, json: null };
        case "hang": return hang(o.signal);
        case "hangApplied": w.addRefundRow(rid); return hang(o.signal);
        default: throw new Error(w.mirrorMode);
      }
    }
  };
  w.mirrorExecutors = () => Object.fromEntries(MIRROR_EXECUTOR_KEYS.map((k) => [k, w.executors[k]]));
  w.count = (prefix) => w.calls.filter((c) => c.startsWith(prefix)).length;
  w.mark = () => w.calls.length;
  w.since = (mark, prefix = "") => w.calls.slice(mark).filter((c) => c.startsWith(prefix)).length;
  w.forbidden = () => w.calls.filter((c) => /^(VOID|CAPTURE|CREATE|RECORD|NOTIFY)/.test(c)).length;
  return w;
}

// ---------- a RECORDED (confirmed) TEST booking on 606998 / USD, requested for the recorded cleanup through the reviewed 0021 request ----------
let stayN = 0;
async function recordedPending(w, { request = true } = {}) {
  stayN += 1;
  const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-08-01", 3 * stayN), to: F.addDays("2027-08-01", 3 * stayN + 2) };
  const r = await F.reserved(db.app, stay);
  const stripeChargeId = `ch_test_${r.id.replace(/-/g, "").slice(0, 16)}`;
  const cap = await F.claimOp(db.app, r.id, OPS.CAPTURE, F.at(8));
  F.ok(await completeOperation(db.app, cap.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: stripeChargeId } }), "capture op");
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
  // the recording (fixtures: healthy claim + confirming LIST proof + 0010 completion), then confirmed with the ONE pristine notification
  const offlineChargeId = String(F.nextReservationId() + 500000);
  const { op, t } = await F.claimRecording(db.app, { ...r }, Date.now(), "w1");
  const { version } = (await db.app.query("SELECT version FROM booking.intents WHERE id = $1", [r.id])).rows[0];
  const ev = await F.chargeListEvidence(db.app, { id: r.id, reservationId: r.reservationId }, F.recordingObserved({ id: r.id, reservationId: r.reservationId, listingId: LIST }, offlineChargeId, { currency: "USD" }), t + 1);
  F.ok(await completeRecordingWithEvidence(db.app, op.id, { workerId: "w1", evidenceId: ev, resultRef: offlineChargeId, expectedVersion: version }), "recording");
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [r.id]);
  F.ok(await applyEvent(db.app, r.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: offlineChargeId }, { now: t + 2, actor: "worker" }), "confirmed");
  const i = await loadIntent(db.app, r.id);
  assert.equal(i.status, "confirmed");
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [r.id])).rows[0].id;
  w.pis.set(r.piId, { id: r.piId, intentId: r.id, attemptId: pa, amount: AMT, chargeId: stripeChargeId, refunded: 0 });
  w.res.set(Number(r.reservationId), { id: Number(r.reservationId), listingMapId: LIST, arrivalDate: stay.from, departureDate: stay.to, totalPrice: 5760, currency: "USD", status: "new", ref: i.ref });
  w.charges.set(Number(r.reservationId), [{ id: Number(offlineChargeId), intentId: r.id, reservationId: Number(r.reservationId), listingMapId: LIST, type: "charge", title: offlineChargeTitle(r.id), amount: 5760, currency: "USD",
    status: "paid", paymentProvider: "offline", paymentMethod: "credit_card" }]);
  const c = { ...r, stripeChargeId, offlineChargeId, attemptId: pa, intent: i, stay, recordingOpId: op.id };
  if (request) {
    const operator = Object.freeze({ approvalRef: "SYNTHETIC-recorded", attemptId: pa, authorizedMinor: i.payment.amountMinor, capturedMinor: i.payment.capturedMinor, currency: "USD", expectedVersion: i.version,
      finalTotalMinor: i.price.finalTotalMinor, from: i.from, guests: i.guests, intentId: r.id, listingId: LIST, offlineChargeId, paymentIntentId: r.piId, planHash: "0".repeat(64),
      reservationId: String(r.reservationId), sessionId: r.sessionId, stripeChargeId, to: i.to });
    F.ok(await requestRecordedTestCleanup(db.app, r.id, { now: F.at(20), env: ENV, operator }), "recorded request");
    assert.equal(await state(r.id), "test_cleanup_pending"); assert.deepEqual(await flags(r.id), [false, false, false]);
  }
  return c;
}
/** the EXISTING cleanup worker settles the cancel + Stripe refund legs (its injected clock tracks real time, so every row / observation it writes is
 *  due and in the past for the real-clock mirror worker that follows) */
async function settleLegsWithCleanupWorker(w, c) {
  const clk = { t: Date.now() };
  for (let k = 0; k < 12; k++) {
    const f = await flags(c.id);
    if (f[0] === true && f[1] === true) return;
    clk.t = Date.now();
    await due(c.id, clk.t);
    const r = await runTestCleanupStep(db.app, { workerId: "tcw1", env: ENV, adapterConfig: cfg(), listings: listings(), executors: { retrieveAccount: w.executors.retrieveAccount, retrievePaymentIntent: w.executors.retrievePaymentIntent,
      retrieveReservation: w.executors.retrieveReservation, lookupPage: w.executors.lookupPage, cancelReservation: w.executors.cancelReservation, createRefund: w.executors.createRefund, retrieveRefund: w.executors.retrieveRefund,
      listRefunds: w.executors.listRefunds }, clock: () => clk.t, stripeAccountId: ACCT, intentId: c.id, hooks: { afterSend: async () => { await new Promise((res) => setTimeout(res, 5)); clk.t = Date.now(); } } });
    await settleLate(r); await new Promise((res) => setTimeout(res, 5));
  }
  assert.fail(`legs not settled: ${JSON.stringify(await flags(c.id))}`);
}
async function mirrorReady(w, opts = {}) {
  const c = await recordedPending(w, opts);
  await settleLegsWithCleanupWorker(w, c);
  assert.deepEqual(await flags(c.id), [true, true, false]); assert.equal(await state(c.id), "test_cleanup_pending");
  const m = await opsOf(c.id, OPS.MIRROR); assert.equal(m.length, 1); assert.deepEqual([m[0].state, m[0].attempts], ["pending", 0]);
  assert.deepEqual([w.cancels.length, w.posts.length, w.mirrorPosts.length], [1, 1, 0], "one cancel PUT + one Stripe refund POST before the mirror");
  return { ...c, mirrorOpId: m[0].id };
}
const mirrorOpts = (w, c, extra = {}) => ({ workerId: "mw1", env: ENV, adapterConfig: cfg(), recordingConfig: recCfg(), clientSnapshotId: F.PREFLIGHT_CLIENT_LABEL, listings: listings(), executors: w.mirrorExecutors(),
  clock: () => Date.now(), stripeAccountId: ACCT, intentId: c.id, ...extra });
const step = async (w, c, extra = {}) => { await due(c.id); return runMirrorStep(db.app, mirrorOpts(w, c, extra)); };
const SHORT = Object.freeze({ readCallMs: 60, writeCallMs: 80 });

// =============================================================================================
test("gate: disabled by default (both flags + dev/preview), production refused, ONE pinned intent, exact executor keys, recording config, listing 606998/USD, TEST database", async () => {
  const w = world();
  const base = { env: ENV, adapterConfig: cfg(), recordingConfig: recCfg(), listings: listings(), executors: w.mirrorExecutors(), clock: () => Date.now(), stripeAccountId: ACCT, intentId: "11111111-2222-4333-8444-555555555555" };
  assert.equal(mirrorWorkerGate(base).ok, true);
  assert.equal(mirrorWorkerGate({ ...base, env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" } }).code, "NOT_ENABLED");
  assert.equal(mirrorWorkerGate({ ...base, env: { ...ENV, VERCEL_ENV: "production" } }).code, "PRODUCTION_REFUSED");
  assert.equal(mirrorWorkerGate({ ...base, intentId: undefined }).code, "INTENT_ID_REQUIRED");
  assert.equal(mirrorWorkerGate({ ...base, executors: { ...w.mirrorExecutors(), createRefund: async () => {} } }).code, "EXECUTOR_NOT_ALLOWED");
  assert.equal(mirrorWorkerGate({ ...base, executors: { retrieveAccount: async () => {} } }).code, "NO_EXECUTORS");
  assert.equal(mirrorWorkerGate({ ...base, recordingConfig: { ...recCfg(), paymentMethod: "cash" } }).code, "RECORDING_CONFIG_PAYMENT_METHOD_NOT_APPROVED");
  assert.equal(mirrorWorkerGate({ ...base, recordingConfig: { ...recCfg(), listingId: 603566 } }).code, "RECORDING_CONFIG_ADAPTER_CONFIG_PILOT_LISTING_FORBIDDEN");
  assert.equal(mirrorWorkerGate({ ...base, listings: new Map([[LIST, { currency: "MXN", timeZone: TZ }]]) }).code, "LISTING_NOT_ALLOWED");
  assert.deepEqual(MIRROR_EXECUTOR_KEYS, ["retrieveAccount", "retrievePaymentIntent", "retrieveReservation", "listOfflineCharges", "refundOfflineCharge"]);
  const c = await recordedPending(w, { request: false });
  const r = await runMirrorStep(db.app, mirrorOpts(w, c, { env: { VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" } }));
  assert.deepEqual([r.status, r.code, w.calls.length], ["refused", "NOT_ENABLED", 0]);
  const r2 = await step(w, c);                                                           // confirmed, not requested: not this worker's state → idle, zero calls
  assert.deepEqual([r2.status, w.calls.length, w.mirrorPosts.length], ["idle", 0, 0]);
});

test("H1 end-to-end on real PG: recorded request → EXISTING cleanup worker (one cancel PUT, one Stripe refund POST) → mirror worker: fresh account / PI / reservation / LIST proofs, claim, ONE exact mirror POST, confirming LIST, 0021 completion, bound terminal → cancelled {t,t,t}, exact ledger id, claim released, end predicate; recording / capture / journal preserved; zero notify sends", async () => {
  const w = world(); const c = await mirrorReady(w);
  const tr0 = await transitions(c.id); const rec0 = await opsOf(c.id, "hostaway.record_offline_charge"); const cap0 = await opsOf(c.id, OPS.CAPTURE);
  const s = await step(w, c);
  assert.equal(s.status, "worked", JSON.stringify(s.actions));
  assert.deepEqual([w.cancels.length, w.posts.length, w.mirrorPosts.length, s.sends, s.mirrorSends], [1, 1, 1, 1, 1], JSON.stringify(s.actions));
  assert.deepEqual(w.mirrorPosts[0], { path: `/v1/guestPayments/charges/${c.reservationId}/${c.offlineChargeId}/refund`, body: { title: mirrorTitle(c.id), amount: 5760, isIncludeInPriceBreakdown: 0 } }, "field-exact body, full POSITIVE amount");
  const order = w.calls.filter((x) => /^(CANCEL|REFUND |MIRROR)/.test(x)).map((x) => x.split(" ")[0]);
  assert.deepEqual(order, ["CANCEL", "REFUND", "MIRROR"], "one cancel, one Stripe refund, one mirror — in order");
  assert.ok(["account", "pi_read", "res_read", "list", "mirror_post", "list"].every((k, i) => s.calls[i].startsWith(k)), JSON.stringify(s.calls));
  assert.ok(s.actions.includes("MIRROR_CLAIMED") && s.actions.includes("REPLY:CANDIDATE") && s.actions.includes("MIRROR_COMPLETED") && s.actions.includes("OFFLINE_CHARGE_REFUND_RECORDED->cancelled"), JSON.stringify(s.actions));
  const m = (await opsOf(c.id, OPS.MIRROR))[0]; const refundRow = w.charges.get(Number(c.reservationId)).find((x) => x.type === "refund");
  assert.deepEqual([m.state, m.attempts, m.result_ref, m.settled_evidence_id !== null], ["succeeded", 1, String(refundRow.id), true]);
  assert.equal(await state(c.id), "cancelled"); assert.deepEqual(await flags(c.id), [true, true, true]);
  assert.equal(await held(c.id), false, "claim released only after all three legs"); assert.deepEqual(await claimReleaseBlockers(db.app, c.id), []);
  assert.deepEqual((await ledger(c.id)).map((l) => [l.entry, l.provider, l.provider_ref]).slice(-1), [["offline_charge_refund_recorded", "hostaway", String(refundRow.id)]], "the ledger carries the exact refund ROW id");
  assert.deepEqual((await ledger(c.id)).map((l) => l.entry), ["authorization_accepted", "capture_succeeded", "offline_charge_recorded", "refund_succeeded", "offline_charge_refund_recorded"]);
  assert.equal(await endOk(c.id), true);
  assert.deepEqual(await opsOf(c.id, "hostaway.record_offline_charge"), rec0, "recording row untouched"); assert.deepEqual(await opsOf(c.id, OPS.CAPTURE), cap0, "capture row untouched");
  const tr = await transitions(c.id);
  assert.deepEqual(tr.slice(0, tr0.length), tr0, "journal / history preserved (append-only)"); assert.deepEqual(tr.at(-1), { from_state: "test_cleanup_pending", to_state: "cancelled", event_type: "OFFLINE_CHARGE_REFUND_RECORDED" });
  assert.deepEqual((await opsOf(c.id, "guest.notify")).map((o) => [o.state, o.attempts]), [["superseded", 0]]); assert.equal(w.forbidden(), 0);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'alert.owner'", [c.id])).rows[0].n, 0);
  assert.deepEqual(await cases(c.id), []);
  assert.deepEqual(s.facts.settlement, { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }); assert.deepEqual(s.facts.mirrorLedgerRefs, [String(refundRow.id)]);
  const s2 = await step(w, c);
  assert.deepEqual([s2.status, w.mirrorPosts.length], ["idle", 1], "nothing else is ever sent");
});

test("ORDER / phase containment: the mirror worker never claims or sends while a leg is open; the cleanup worker never touches the mirror row; after the mirror the cleanup worker is idle", async () => {
  const w = world(); const c = await recordedPending(w);
  const r0 = await step(w, c);
  assert.deepEqual([r0.status, w.mirrorPosts.length, w.calls.length], ["worked", 0, 0]); assert.ok(r0.actions.includes("WAIT:LEGS_NOT_SETTLED"), JSON.stringify(r0.actions));
  assert.equal((await opsOf(c.id, OPS.MIRROR)).length, 0, "no mirror row before both legs");
  await settleLegsWithCleanupWorker(w, c);
  assert.deepEqual([(await opsOf(c.id, OPS.MIRROR))[0].state, w.mirrorPosts.length], ["pending", 0], "the cleanup worker queued (via the reducer) but never touched the mirror row");
  const s = await step(w, c); assert.equal(await state(c.id), "cancelled", JSON.stringify(s.actions));
  const cl = await runTestCleanupStep(db.app, { workerId: "tcw2", env: ENV, adapterConfig: cfg(), listings: listings(), executors: { retrieveAccount: w.executors.retrieveAccount, retrievePaymentIntent: w.executors.retrievePaymentIntent,
    retrieveReservation: w.executors.retrieveReservation, lookupPage: w.executors.lookupPage, cancelReservation: w.executors.cancelReservation, createRefund: w.executors.createRefund, retrieveRefund: w.executors.retrieveRefund,
    listRefunds: w.executors.listRefunds }, clock: () => Date.now(), stripeAccountId: ACCT, intentId: c.id });
  assert.deepEqual([cl.status, w.cancels.length, w.posts.length, w.mirrorPosts.length], ["idle", 1, 1, 1]);
});

test("pre-send LIST discovery fails CLOSED with ZERO POST: an existing typed-linked refund / a refund row without a typed link (ambiguous) / a mirror-marker lookalike / a same-amount refund / a changed original → HOLD (owner case), the mirror row stays pristine", async () => {
  for (const [label, prep, code] of [
    ["linked refund exists", (w, c) => w.addRefundRow(c.reservationId, { title: "someone else's refund" }), "MIRROR_HOLD_MIRROR_ALREADY_LINKED"],
    ["untyped link", (w, c) => w.addRefundRow(c.reservationId, { title: "legacy refund", refundInfo: null, amount: -100 }), "MIRROR_HOLD_MIRROR_DISCOVERY_AMBIGUOUS"],
    ["marker lookalike", (w, c) => w.addRefundRow(c.reservationId, { title: `MARAVILLA REFUND ${mirrorTitle(c.id).slice(17).toUpperCase()}​`, amount: -100, refundInfo: { id: 1, chargeId: 2, refundedChargeId: 3 } }), "MIRROR_HOLD_MIRROR_MARKER_PRESENT"],
    ["same-amount refund of another charge", (w, c) => w.addRefundRow(c.reservationId, { title: "other", refundInfo: { id: 1, chargeId: 2, refundedChargeId: 3 } }), "MIRROR_HOLD_MIRROR_AMOUNT_PRESENT"],
    ["original changed", (w, c) => { w.charges.get(Number(c.reservationId))[0].status = "refunded"; }, "MIRROR_HOLD_ORIGINAL_STATUS"]]) {
    const w = world(); const c = await mirrorReady(w);
    prep(w, c);
    const s = await step(w, c);
    assert.ok(s.actions.includes(`ESCALATE:${code}`), `${label}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.mirrorPosts.length, s.sends], [0, 0], label);
    assert.deepEqual([(await opsOf(c.id, OPS.MIRROR))[0].state, (await opsOf(c.id, OPS.MIRROR))[0].attempts], ["pending", 0], `${label}: pristine row`);
    assert.equal(await state(c.id), "reconciliation_required", label); assert.deepEqual(await flags(c.id), [true, true, false]);
    assert.ok(await held(c.id), `${label}: claim held`);
  }
});

test("a reply is NEVER proof: inverted / foreign / untyped link or a pending status reply → row unknown with NO confirming read and no completion; a 'good' reply whose confirming LIST contradicts (partial amount) → unknown; never a second POST; the next session reconciles READ-ONLY into an explicit owner case", async () => {
  for (const [mode, replyCode, landed] of [["inverted", "REPLY!REPLY_REFUNDED_ID_NOT_ORIGINAL", "MIRROR_UNKNOWN_LANDED"], ["foreignLink", "REPLY!REPLY_REFUNDED_ID_NOT_ORIGINAL", "MIRROR_UNKNOWN_ABSENT"],
    ["noLinkRow", "MIRROR_UNKNOWN:CONFIRM_LINK_UNTYPED", "MIRROR_UNKNOWN_AMBIGUOUS"], ["pendingStatus", "REPLY!REPLY_STATUS", "MIRROR_UNKNOWN_LANDED"]]) {
    const w = world(); const c = await mirrorReady(w); w.mirrorMode = mode; const m0 = w.mark();
    const s = await step(w, c);
    assert.ok(s.actions.includes(replyCode), `${mode}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.mirrorPosts.length, w.since(m0, "LIST")], [1, replyCode.startsWith("REPLY!") ? 1 : 2], `${mode}: no confirming LIST after an inadmissible reply (one after an admitted candidate)`);
    const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.deepEqual([m.state, m.attempts, m.settled_evidence_id], ["outcome_unknown", 1, null], mode);
    assert.deepEqual(await flags(c.id), [true, true, false]); assert.ok(await held(c.id));
    const s2 = await step(w, c);
    assert.ok(s2.actions.includes(`ESCALATE:${landed}`), `${mode}: ${JSON.stringify(s2.actions)}`);
    assert.deepEqual([w.mirrorPosts.length, await state(c.id)], [1, "reconciliation_required"], `${mode}: never resent; owner case`);
    assert.equal((await opsOf(c.id, OPS.MIRROR))[0].state, "outcome_unknown", `${mode}: the row is never re-opened`);
  }
  // a good reply, contradicting confirming LIST (partial amount recorded by the provider): unknown via the proof, then LANDED owner case
  const w = world(); const c = await mirrorReady(w); w.mirrorMode = "partial";
  const m0 = w.mark(); const s = await step(w, c);
  assert.ok(s.actions.includes("REPLY:CANDIDATE") && s.actions.some((a) => a.startsWith("MIRROR_UNKNOWN:CONFIRM_MIRROR_ROW_AMOUNT")), JSON.stringify(s.actions));
  assert.deepEqual([w.mirrorPosts.length, w.since(m0, "LIST"), (await opsOf(c.id, OPS.MIRROR))[0].state], [1, 2, "outcome_unknown"]);
  const s2 = await step(w, c);
  assert.ok(s2.actions.includes("ESCALATE:MIRROR_UNKNOWN_LANDED"), JSON.stringify(s2.actions)); assert.equal(w.mirrorPosts.length, 1);
});

test("lost / uncertain send: timeout (applied or not), 500 (applied or not) → row unknown, nothing else in the step; the next session's READ-ONLY reconciliation → LANDED / ABSENT owner case; ZERO resend across sessions", async () => {
  for (const [mode, expect] of [["hang", "MIRROR_UNKNOWN_ABSENT"], ["hangApplied", "MIRROR_UNKNOWN_LANDED"], ["500", "MIRROR_UNKNOWN_ABSENT"], ["500Applied", "MIRROR_UNKNOWN_LANDED"]]) {
    const w = world(); const c = await mirrorReady(w); w.mirrorMode = mode;
    const s = await step(w, c, { timeouts: SHORT });
    assert.ok(s.actions.some((a) => a.startsWith("MIRROR_UNKNOWN:")), `${mode}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.mirrorPosts.length, (await opsOf(c.id, OPS.MIRROR))[0].state, await state(c.id)], [1, "outcome_unknown", "test_cleanup_pending"], mode);
    for (let k = 0; k < 2; k++) { const s2 = await step(w, c, { timeouts: SHORT }); if (k === 0) assert.ok(s2.actions.includes(`ESCALATE:${expect}`), `${mode}: ${JSON.stringify(s2.actions)}`); }
    assert.deepEqual([w.mirrorPosts.length, await state(c.id), (await opsOf(c.id, OPS.MIRROR))[0].state], [1, "reconciliation_required", "outcome_unknown"], `${mode}: no resend, no new key`);
    assert.equal((await opsOf(c.id, OPS.MIRROR)).length, 1, `${mode}: one row ever`);
  }
});

test("latest-leg contradictions: a NEW failed Stripe refund observation after both legs → the worker waits (DB legs predicate), ZERO claim / POST; restoration proceeds. A contradiction between claim and send (afterClaim hook) → SEND_ABORTED, unknown WITHOUT a POST; between send and completion → the DB refuses the completion (row unknown, one POST)", async () => {
  const refundRead = async (c, status) => {
    const re = (await opsOf(c.id, OPS.REFUND))[0].result_ref;
    const rid = await requestRead(db.app, c.id, "stripe.retrieve_refund", re, { now: Date.now() });
    assert.ok(await claimNextOperation(db.app, { workerId: "w-read", now: Date.now(), opId: rid }));
    F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: Date.now(), outcome: { status: "succeeded" } }));
    F.ok(await recordProviderEvidence(db.app, { readOpId: rid, kind: "stripe_refund", externalRef: re, status, observed: { refundId: re, paymentIntentId: c.piId, chargeId: c.stripeChargeId, amountMinor: AMT, currency: "USD", status, created: Math.floor(Date.now() / 1000) } }));
  };
  const w = world(); const c = await mirrorReady(w); const m0 = w.mark();
  await refundRead(c, "failed");
  const s = await step(w, c);
  assert.ok(s.actions.includes("WAIT:LEGS_STRIPE_REFUND_NOT_SETTLED"), JSON.stringify(s.actions));
  assert.deepEqual([w.mirrorPosts.length, w.since(m0), (await opsOf(c.id, OPS.MIRROR))[0].state], [0, 0, "pending"], "no read, no claim, no POST");
  await new Promise((r) => setTimeout(r, 15)); await refundRead(c, "succeeded");
  const s1 = await step(w, c); assert.equal(await state(c.id), "cancelled", JSON.stringify(s1.actions)); assert.equal(w.mirrorPosts.length, 1);
  // between claim and send
  const w2 = world(); const c2 = await mirrorReady(w2);
  const s2 = await step(w2, c2, { hooks: { afterClaim: async () => { await refundRead(c2, "failed"); } } });
  assert.ok(s2.actions.includes("SEND_ABORTED:LEGS_STRIPE_REFUND_NOT_SETTLED"), JSON.stringify(s2.actions));
  assert.deepEqual([w2.mirrorPosts.length, (await opsOf(c2.id, OPS.MIRROR))[0].state], [0, "outcome_unknown"]);
  const s2b = await step(w2, c2); assert.ok(s2b.actions.includes("ESCALATE:MIRROR_UNKNOWN_ABSENT"), JSON.stringify(s2b.actions)); assert.equal(w2.mirrorPosts.length, 0);
  // between send and completion: the dedicated completion re-checks the legs inside the database
  const w3 = world(); const c3 = await mirrorReady(w3);
  const s3 = await step(w3, c3, { hooks: { afterConfirmEvidence: async () => { await refundRead(c3, "failed"); } } });
  assert.ok(s3.actions.some((a) => a.startsWith("COMPLETE!MIRROR_LEGS_UNSETTLED")), JSON.stringify(s3.actions));
  assert.deepEqual([w3.mirrorPosts.length, (await opsOf(c3.id, OPS.MIRROR))[0].state, await state(c3.id)], [1, "outcome_unknown", "test_cleanup_pending"]);
  assert.deepEqual(await flags(c3.id), [true, true, false]); assert.ok(await held(c3.id));
});

test("stop discipline (signal / deadline / step budget): observed after each awaited proof, before the claim and the send, after the send (no confirming read / completion), after the completion (COMPLETED:EVENT_DEFERRED, next session finalizes WITHOUT a POST), inside the terminal transaction (vetoed, nothing mutated)", async () => {
  // (a) signal right after the PI read: no reservation read, no LIST, no claim, no POST
  { const w = world(); const c = await mirrorReady(w); const ac = new AbortController(); const m0 = w.mark();
    const s = await step(w, c, { signal: ac.signal, hooks: { afterPiRead: async () => ac.abort() } });
    assert.ok(s.stop && s.stop.code === "SIGNAL", JSON.stringify(s)); assert.deepEqual([w.since(m0, "RES"), w.since(m0, "LIST"), w.mirrorPosts.length], [0, 0, 0]);
    assert.deepEqual([(await opsOf(c.id, OPS.MIRROR))[0].state, await state(c.id)], ["pending", "test_cleanup_pending"]); }
  // (b) deadline crossed after the POST: unknown bookkeeping only — no confirming LIST, no completion, no terminal
  { const w = world(); const c = await mirrorReady(w); const clk = { t: Date.now() }; const deadline = clk.t + 45 * 1000; const m0 = w.mark();      // whole-call room before the deadline (20 s + 15 s margin), still inside the 60 s op lease when it is crossed
    const s = await step(w, c, { clock: () => clk.t, deadlineAt: deadline, hooks: { afterSend: async () => { clk.t = deadline + 1; } } });
    assert.ok(s.stop && s.stop.code === "DEADLINE" && s.stop.where === "after_mirror_send", JSON.stringify(s.stop)); assert.deepEqual([w.mirrorPosts.length, w.since(m0, "LIST")], [1, 1]);
    assert.equal((await opsOf(c.id, OPS.MIRROR))[0].state, "outcome_unknown"); assert.equal(await state(c.id), "test_cleanup_pending");
    const s2 = await step(w, c); assert.ok(s2.actions.includes("ESCALATE:MIRROR_UNKNOWN_LANDED"), JSON.stringify(s2.actions)); assert.equal(w.mirrorPosts.length, 1); }
  // (c) signal right after the durable completion: event deferred; the next session finalizes read-only, no second POST
  { const w = world(); const c = await mirrorReady(w); const ac = new AbortController(); const m0 = w.mark();
    const s = await step(w, c, { signal: ac.signal, hooks: { afterComplete: async () => ac.abort() } });
    assert.ok(s.actions.includes("MIRROR_COMPLETED") && s.actions.includes("COMPLETED:EVENT_DEFERRED"), JSON.stringify(s.actions));
    const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.deepEqual([m.state, m.settled_evidence_id !== null], ["succeeded", true]);
    assert.deepEqual([await state(c.id), await held(c.id)], ["test_cleanup_pending", true], "no terminal / release after the stop");
    const s2 = await step(w, c); assert.ok(s2.actions.includes("OFFLINE_CHARGE_REFUND_RECORDED->cancelled"), JSON.stringify(s2.actions));
    assert.deepEqual([w.mirrorPosts.length, w.since(m0, "LIST"), await endOk(c.id)], [1, 2, true]); }
  // (d) signal during the terminal transaction's own proof (beforeClaim of... the event): vetoed, rolled back
  { const w = world(); const c = await mirrorReady(w); const ac = new AbortController();
    const s = await step(w, c, { signal: ac.signal, hooks: { afterConfirmEvidence: async () => { setTimeout(() => ac.abort(), 5); } } });
    assert.ok(s.stop, JSON.stringify(s)); assert.equal(w.mirrorPosts.length, 1);
    const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.ok(["succeeded", "outcome_unknown"].includes(m.state), m.state);
    assert.equal(await state(c.id), "test_cleanup_pending", "never a terminal after an observed stop"); assert.ok(await held(c.id));
    const s2 = await step(w, c); assert.equal(w.mirrorPosts.length, 1); assert.ok(["cancelled", "reconciliation_required"].includes(await state(c.id)), JSON.stringify(s2.actions)); }
  // (f) deterministic: the signal aborts DURING the terminal transaction's own proof query (real client proxy) → the event is vetoed and rolled back:
  //     the durable succeeded row stays, intent / claim untouched, stop reported; the next session finalizes without a POST
  { const w = world(); const c = await mirrorReady(w); const ac = new AbortController(); const m0 = w.mark();
    const proxyPool = { query: (...a) => db.app.query(...a), connect: async () => { const cl = await db.app.connect(); return new Proxy(cl, { get(t, k) {
      if (k === "query") return async (sql, p) => { const r = await t.query(sql, p); if (typeof sql === "string" && sql.includes("e.kind = 'hostaway_offline_charges' AND e.status = 'listed'")) ac.abort(); return r; };
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } }); } };
    const s = await runMirrorStep(proxyPool, mirrorOpts(w, c, { signal: ac.signal }));
    assert.ok(s.actions.includes("MIRROR_COMPLETED") && s.actions.includes("OFFLINE_CHARGE_REFUND_RECORDED!STOPPED"), JSON.stringify(s.actions));
    assert.ok(s.stop && s.stop.code === "SIGNAL" && s.stop.where === "in_tx_after_checks_OFFLINE_CHARGE_REFUND_RECORDED", JSON.stringify(s.stop));
    const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.deepEqual([m.state, m.settled_evidence_id !== null], ["succeeded", true]);
    assert.deepEqual([await state(c.id), await held(c.id), (await flags(c.id))[2]], ["test_cleanup_pending", true, false], "vetoed: nothing mutated");
    assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.payment_ledger WHERE intent_id = $1 AND entry = 'offline_charge_refund_recorded'", [c.id])).rows[0].n, 0);
    const s2 = await step(w, c); assert.ok(s2.actions.includes("OFFLINE_CHARGE_REFUND_RECORDED->cancelled"), JSON.stringify(s2.actions));
    assert.deepEqual([w.mirrorPosts.length, w.since(m0, "MIRROR"), await endOk(c.id)], [1, 1, true]); }
  // (e) step budget exhausted before any call: idle, zero calls
  { const w = world(); const c = await mirrorReady(w); const m0 = w.mark();
    const s = await step(w, c, { monotonic: (() => { let t = 0; return () => (t += 100000); })() });
    assert.ok(s.stop && s.stop.code === "STEP_BUDGET", JSON.stringify(s.stop)); assert.equal(w.since(m0), 0); }
});

test("leases / concurrency / wire containment: a second worker on the pinned intent is idle (work lease); a tampered op lease aborts the send (unknown, ZERO POST); the exact mirror POST counter is 1 in a full run and the executor key set is exact", async () => {
  const w = world(); const c = await mirrorReady(w);
  // the work lease held elsewhere → idle
  const m0 = w.mark();
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'other', work_lease_until = now() + interval '50 seconds' WHERE intent_id = $1", [c.id]);
  const s0 = await step(w, c); assert.deepEqual([s0.status, w.since(m0)], ["idle", 0]);
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [c.id]);
  // tampered op lease between claim and send → SEND_ABORTED, unknown, no POST
  const s1 = await step(w, c, { hooks: { afterClaim: async (op) => { await db.owner.query("UPDATE booking.external_operations SET lease_until = now() + interval '1 second' WHERE id = $1", [op.id]); } } });
  assert.ok(s1.actions.includes("SEND_ABORTED:OPERATION_LEASE_TOO_SHORT"), JSON.stringify(s1.actions)); assert.equal(w.mirrorPosts.length, 0);
  assert.equal((await opsOf(c.id, OPS.MIRROR))[0].state, "outcome_unknown");
  // a full run: exactly ONE POST and the counter moved before the transport (the hook sees sends = 1 while the POST is in flight)
  const w2 = world(); const c2 = await mirrorReady(w2); let seen = null;
  w2.onMirrorPost = async () => { seen = w2.mirrorPosts.length; };
  const s2 = await step(w2, c2); assert.equal(await state(c2.id), "cancelled", JSON.stringify(s2.actions));
  assert.deepEqual([seen, w2.mirrorPosts.length, s2.mirrorSends, s2.sends], [1, 1, 1, 1]);
  assert.deepEqual(Object.keys(w2.mirrorExecutors()).sort(), [...MIRROR_EXECUTOR_KEYS].sort());
  assert.equal(typeof _internal.preSend, "function");
});

// =============================================================================================
// rev2 (ROOT HOLD 5885005598): F1 full cancelled-reservation identity, F2 stop rechecks at every awaited read-completion / evidence boundary,
// F3 worker counter before the bounded executor call

const evidenceCount = async (id, kind) => (await db.app.query("SELECT count(*)::int AS n FROM booking.provider_evidence WHERE intent_id = $1 AND kind = $2", [id, kind])).rows[0].n;
const lastEvidence = async (id, kind) => (await db.app.query("SELECT status, observed FROM booking.provider_evidence WHERE intent_id = $1 AND kind = $2 ORDER BY observed_at DESC LIMIT 1", [id, kind])).rows[0];
const readRows = async (id, opType) => (await db.app.query("SELECT state, error_code FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND retry_class = 'read' ORDER BY created_at", [id, opType])).rows;

test("F1 reservation identity: a CANCELLED reservation whose listing / stay / total / currency / channel / reference differs from the intent is persisted truthfully (status cancelled, the observed field as seen) and the mirror leg escalates with ZERO POST and a pristine mirror row; the healthy control completes with ONE POST", async () => {
  const mutations = [
    ["TOTAL", (r) => { r.totalPrice = 999; }, (o) => assert.equal(o.totalMinor, 99900)],
    ["LISTING", (r) => { r.listingMapId = 603566; }, (o) => assert.equal(o.listingId, 603566)],
    ["ARRIVAL", (r) => { r.arrivalDate = F.addDays(r.arrivalDate, -1); }, null],
    ["DEPARTURE", (r) => { r.departureDate = F.addDays(r.departureDate, 1); }, null],
    ["CURRENCY", (r) => { r.currency = "MXN"; }, (o) => assert.equal(o.currency, "MXN")],
    ["CHANNEL", (r) => { r.channelId = 2018; }, (o) => assert.equal(o.channelId, 2018)],
    ["REF", (r) => { r.ref = `${r.ref}x`; }, null]
  ];
  for (const [code, mutate, checkObserved] of mutations) {
    const w = world(); const c = await mirrorReady(w); const m0 = w.mark();
    const r = w.res.get(Number(c.reservationId)); assert.equal(r.status, "cancelled"); mutate(r);
    const s = await step(w, c);
    assert.ok(s.actions.includes(`ESCALATE:RESERVATION_IDENTITY_${code}_MISMATCH`), `${code}: ${JSON.stringify(s.actions)}`);
    assert.deepEqual([w.mirrorPosts.length, w.since(m0, "MIRROR"), w.since(m0, "LIST")], [0, 0, 0], `${code}: zero POST, no LIST after a failed identity`);
    const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.deepEqual([m.state, m.attempts, m.dispatched_at], ["pending", 0, null], `${code}: mirror row pristine`);
    assert.equal(await state(c.id), "reconciliation_required");
    const e = await lastEvidence(c.id, "hostaway_reservation"); assert.equal(e.status, "cancelled", `${code}: the observed status is persisted as seen, never a fabricated active status`);
    if (checkObserved) checkObserved(e.observed);
  }
  // healthy control: the same world shape, untouched → ONE exact POST, cancelled
  const w = world(); const c = await mirrorReady(w);
  const s = await step(w, c); assert.equal(await state(c.id), "cancelled", JSON.stringify(s.actions)); assert.equal(w.mirrorPosts.length, 1);
  const e = await lastEvidence(c.id, "hostaway_reservation"); assert.deepEqual([e.status, e.observed.channelId, e.observed.bookingRef, e.observed.totalMinor], ["cancelled", 2000, c.intent.ref, AMT]);
});

/** a REAL checked-out pg client, wrapped: once `armed`, the first COMMIT it runs (the read row's completion) fires `onCommit` — the exact query boundary
 *  between the committed read-row truth and the evidence write */
function commitTrap(onCommit) {
  const t = { armed: false, fired: 0 };
  t.pool = { query: (...a) => db.app.query(...a), connect: async () => { const cl = await db.app.connect(); return new Proxy(cl, { get(target, k) {
    if (k === "query") return async (sql, p) => { const r = await target.query(sql, p); if (t.armed && sql === "COMMIT") { t.armed = false; t.fired += 1; await onCommit(); } return r; };
    const v = target[k]; return typeof v === "function" ? v.bind(target) : v; } }); } };
  return t;
}

test("F2 query-boundary stop (signal + deadline) after the READ ROW's own COMMIT and before the evidence write, for the PI / reservation / LIST reads: the committed read row stays succeeded (truth preserved), NO evidence row is added after the stop, the stop is reported, nothing further (no later read, no claim, no POST)", async () => {
  const boundaries = [
    ["payment_intent", OPS.PI_READ, "retrievePaymentIntent", "RES"],
    ["hostaway_reservation", OPS.RES_READ, "retrieveReservation", "LIST"],
    ["hostaway_offline_charges", OPS.LIST_READ, "listOfflineCharges", "MIRROR"]
  ];
  for (const [kind, opType, executor, nextCall] of boundaries) {
    for (const mode of ["SIGNAL", "DEADLINE"]) {
      const w = world(); const c = await mirrorReady(w); const ac = new AbortController(); const clk = { t: Date.now() }; const deadline = clk.t + 45 * 1000;
      const n0 = await evidenceCount(c.id, kind); const rows0 = (await readRows(c.id, opType)).length; const m0 = w.mark();
      const trap = commitTrap(async () => { if (mode === "SIGNAL") ac.abort(); else clk.t = deadline + 1; });
      const ex = { ...w.mirrorExecutors(), [executor]: async (...a) => { const r = await w.executors[executor](...a); trap.armed = true; return r; } };
      await due(c.id, clk.t);
      const s = await runMirrorStep(trap.pool, mirrorOpts(w, c, { executors: ex, signal: ac.signal, clock: () => clk.t, deadlineAt: deadline }));
      assert.equal(trap.fired, 1, `${kind}/${mode}: the trap fired on the read row's COMMIT ${JSON.stringify(s)}`);
      assert.ok(s.stop && s.stop.code === mode, `${kind}/${mode}: ${JSON.stringify(s.stop)} ${JSON.stringify(s.actions)}`);
      assert.equal(await evidenceCount(c.id, kind), n0, `${kind}/${mode}: no evidence written after the stop`);
      const rows = await readRows(c.id, opType); assert.equal(rows.length, rows0 + 1); assert.equal(rows[rows.length - 1].state, "succeeded", `${kind}/${mode}: the committed read row is preserved as it was committed`);
      assert.deepEqual([w.since(m0, nextCall), w.mirrorPosts.length], [0, 0], `${kind}/${mode}: nothing after the stop`);
      const m = (await opsOf(c.id, OPS.MIRROR))[0]; assert.deepEqual([m.state, m.attempts], ["pending", 0]); assert.equal(await state(c.id), "test_cleanup_pending");
    }
  }
});

test("F3 worker counter: the mirror send counter and call log move BEFORE the bounded executor is invoked (the synchronous beforeSend snapshot sees sends = 1 while the executor has not run); a synchronously throwing executor still counts ONE send, the row is unknown (MIRROR_CALL_FAILED) and the next session reconciles READ-ONLY", async () => {
  const w = world(); const c = await mirrorReady(w); let snapshot = null; let invokedBeforeSnapshot = null;
  const ex = { ...w.mirrorExecutors(), refundOfflineCharge: (req) => { invokedBeforeSnapshot = snapshot === null; w.mirrorPosts.push({ path: req.path, sync: true }); throw new Error("sync transport failure"); } };
  const s = await step(w, c, { executors: ex, hooks: { beforeSend: (snap) => { snapshot = snap; } } });
  assert.deepEqual([snapshot && snapshot.sends, snapshot && snapshot.mirrorSends, invokedBeforeSnapshot, s.sends, s.mirrorSends], [1, 1, false, 1, 1], JSON.stringify(s.actions));
  assert.ok(snapshot && Object.isFrozen(snapshot) && snapshot.calls.at(-1) === `mirror_post:${c.offlineChargeId}`);
  assert.ok(s.actions.includes("MIRROR_UNKNOWN:MIRROR_CALL_FAILED"), JSON.stringify(s.actions));
  assert.equal((await opsOf(c.id, OPS.MIRROR))[0].state, "outcome_unknown");
  const s2 = await step(w, c); assert.ok(s2.actions.includes("ESCALATE:MIRROR_UNKNOWN_ABSENT"), JSON.stringify(s2.actions)); assert.equal(w.mirrorPosts.length, 1);
});
