// Stage E7.4a — offline cleanup worker (void / host-cancel) on a throwaway local PostgreSQL with FAKE Stripe + Hostaway executors
// (no network, no SDK, no credentials). Runtime code runs as mv_booking_app; db.owner is used ONLY to tamper leases in guard tests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead } from "../../lib/booking-db/operations.js";
import { runCleanupStep, compensationWorkerGate, CLEANUP_EXECUTOR_KEYS, CLEANUP_DEFAULT_TIMEOUTS, CLEANUP_LIMITS, OPS } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { paymentIntentProofObservationV3 } from "../../lib/checkout/capture-proof.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ACCT = "acct_1TestCleanupWorker";
const REF_FIELD = 777004;
const TZ = "America/Mazatlan";
const L = (n) => 890000 + n;
const MIN = F.MIN;
const SHORT = Object.freeze({ readCallMs: 40, writeCallMs: 60 });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const httpError = (statusCode) => Object.assign(new Error(`provider ${statusCode}`), { statusCode });
let stayN = 0;
const nextStay = () => { stayN += 1; return { from: addDays("2027-01-01", 6 * stayN), to: addDays("2027-01-01", 6 * stayN + 4) }; };

// ---------- fake Stripe + Hostaway world ----------
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), voids: [], cancels: [], signals: [], voidMode: "ok", cancelMode: "ok", piMode: "ok", accountMode: "ok",
    retrieveMode: "ok", onPiRead: null, onResRead: null, onVoid: null, onCancel: null };
  const hang = (signal) => { w.signals.push(signal); return new Promise(() => {}); };
  w.piObj = (p) => {
    const cap = p.status === "succeeded";
    return { object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount,
      amount_received: cap ? p.amount : 0, amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "mxn",
      metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
      latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: cap, amount: p.amount,
        amount_captured: cap ? p.amount : 0, amount_refunded: p.status === "canceled" && p.refundFieldsOnCancel ? p.amount : 0, currency: "mxn", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } };
  };
  const doVoid = (p) => { p.status = "canceled"; };
  const full = (r) => {
    const o = { id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
      currency: r.currency, status: r.status };
    if (!r.noRef) o.customFieldValues = [{ customFieldId: REF_FIELD, value: r.ref }];
    return o;
  };
  const doCancel = (r) => { r.status = "cancelled"; };
  w.executors = {
    retrieveAccount: async (o = {}) => { w.calls.push("ACCOUNT"); if (w.accountMode === "hang") return hang(o.signal);
      return { object: "account", id: w.accountMode === "other" ? "acct_1SomeoneElse" : ACCT }; },
    retrievePaymentIntent: async (id, params, o = {}) => {
      assert.deepEqual(params, { expand: ["latest_charge"] });
      w.calls.push(`PI ${id}`);
      if (w.onPiRead) await w.onPiRead(id);
      if (w.piMode === "hang") return hang(o.signal);
      if (w.piMode === "500") throw httpError(500);
      return w.piObj(w.pis.get(id));
    },
    cancelPaymentIntent: async (id, params, o = {}) => {
      w.calls.push(`VOID ${id}`); w.voids.push({ id, params: JSON.parse(JSON.stringify(params)), key: o.idempotencyKey }); w.signals.push(o.signal);
      if (w.onVoid) await w.onVoid(id);
      const p = w.pis.get(id);
      switch (w.voidMode) {
        case "ok": doVoid(p); return w.piObj(p);
        case "replyOnly": return { ...w.piObj(p), status: "canceled" };
        case "500": throw httpError(500);
        case "500Canceled": doVoid(p); throw httpError(500);
        case "409": throw httpError(409);
        case "malformed": doVoid(p); return { object: "payment_intent" };
        case "hang": return hang(o.signal);
        case "late": return new Promise((resolve) => { w.releaseLate = () => { doVoid(p); resolve(w.piObj(p)); }; });
        default: throw new Error(w.voidMode);
      }
    },
    retrieveReservation: async (req, o = {}) => {
      w.calls.push(`RES ${req.path}`);
      if (w.onResRead) await w.onResRead();
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
        case "late": return new Promise((resolve) => { w.releaseLate = () => { doCancel(r); resolve({ httpStatus: 200, json: { status: "success", result: full(r) } }); }; });
        default: throw new Error(w.cancelMode);
      }
    }
  };
  w.count = (prefix) => w.calls.filter((c) => c.startsWith(prefix)).length;
  return w;
}
const cfgFor = (ids) => validateAdapterConfig({ allowedListingIds: ids, refFieldId: REF_FIELD, channelId: 2000, currency: "MXN" });

// ---------- intents in the cleanup states (accepted E3 transitions through the DB) ----------
async function attach(w, id, { reservationId = null, n, stay, noRef = false } = {}) {
  const intent = await loadIntent(db.app, id);
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [id])).rows[0].id;
  const pi = intent.payment.paymentIntentId;
  w.pis.set(pi, { id: pi, intentId: id, attemptId: pa, status: "requires_capture", amount: 576000, chargeId: `ch_test_${id.slice(0, 8)}`,
    captureBeforeSec: intent.payment.captureBefore / 1000 });
  if (reservationId) w.res.set(Number(reservationId), { id: Number(reservationId), listingMapId: L(n), arrivalDate: stay.from, departureDate: stay.to,
    totalPrice: 5760, currency: "MXN", status: "new", ref: intent.ref, noRef });
  return { id, piId: pi, ref: intent.ref, reservationId, paymentAttemptId: pa, intent };
}
async function reservationFailed(w, n) {
  const stay = { listingId: L(n), ...nextStay() };
  const a = await F.authorized(db.app, stay);
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  return attach(w, a.id, { n, stay });
}
async function captureFailed(w, n, cls = "P", { rid = null, noRef = false } = {}) {
  const stay = { listingId: L(n), ...nextStay() };
  if (cls === "Z") {
    const p = await F.pending(db.app, stay);
    const piId = `pi_test_${p.id.slice(0, 8)}`;
    const cb = F.at(4) + 12 * 60 * MIN + 30 * MIN;
    F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { captureBefore: cb }), { now: F.at(5), actor: "webhook" }));
    F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
    const r = rid ?? F.nextReservationId();
    const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
    const tAfter = (cb - F.T0) / MIN + 1;
    await recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: F.reservationFor(stay, r) }, { now: F.at(tAfter) });
    F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(6), outcome: { status: "succeeded", resultRef: r } }));
    F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, r) }, { now: F.at(tAfter), actor: "worker" }));
    return attach(w, p.id, { reservationId: String(r), n, stay, noRef });
  }
  let r;
  if (rid) {
    const d = await F.dispatched(db.app, stay);
    const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
    await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(7) });
    F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
    F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(7), actor: "worker" }));
    r = { ...d, reservationId: rid };
  } else r = await F.reserved(db.app, stay);
  if (cls === "D") await F.runOp(db.app, r.id, OPS.CAPTURE, 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  return attach(w, r.id, { reservationId: String(r.reservationId), n, stay, noRef });
}

function harness(w, ns, { start = F.at(20) } = {}) {
  const ids = ns.map(L);
  const clk = { t: start, m: 0 };
  const h = {
    clk, w,
    opts: (extra = {}) => ({ workerId: "cw1", env: ENV, adapterConfig: cfgFor(ids), listings: new Map(ids.map((id) => [id, { currency: "MXN", timeZone: TZ }])),
      executors: w.executors, clock: () => clk.t, stripeAccountId: ACCT, ...extra }),
    step: (extra = {}) => runCleanupStep(db.app, h.opts(extra)),
    until: async (intentId, pred, { max = 40, advanceMs = MIN, extra = {} } = {}) => {
      for (let k = 0; k < max; k++) {
        const st = await state(intentId);
        if (pred(st)) return st;
        const r = await h.step({ intentId, ...extra });
        await settleLate(r);
        clk.t += advanceMs;
      }
      assert.fail(`not reached after ${max} steps: ${await state(intentId)}`);
    }
  };
  return h;
}
const settleLate = (r) => Promise.race([r.late, new Promise((res) => setTimeout(res, 200))]);
const state = async (id) => (await loadIntent(db.app, id)).status;
const opsOf = async (id, opType) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, opType])).rows;
const events = async (id, type) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, type]);
const reasonOf = async (id) => (await db.app.query("SELECT reason_code FROM booking.intents WHERE id = $1", [id])).rows[0].reason_code;
const legs = async (id) => { const r = (await db.app.query("SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1", [id])).rows[0]; return [r.c, r.a]; };
const isEnd = (st) => ["cancelled", "authorization_released", "reconciliation_required"].includes(st);
const setOpLease = (opId, untilMs, worker = null) => db.owner.query(
  `UPDATE booking.external_operations SET lease_until = $2${worker ? ", lease_worker_id = $3" : ""} WHERE id = $1`, worker ? [opId, new Date(untilMs), worker] : [opId, new Date(untilMs)]);
const setWorkLease = (intentId, untilMs, worker = null) => db.owner.query(
  `UPDATE booking.intent_work SET work_lease_until = $2${worker ? ", work_worker_id = $3" : ""} WHERE intent_id = $1`, worker ? [intentId, new Date(untilMs), worker] : [intentId, new Date(untilMs)]);
const snapCapture = async (id) => (await db.app.query("SELECT id, state, attempts, dispatched_at, error_code, updated_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY id", [id, OPS.CAPTURE])).rows;

// =============================================================================================
test("gate: production refused; explicit dev/preview flag; exact account / listings / currency / IANA zone; EXACT executor keys", async () => {
  const w = world();
  const base = { env: ENV, adapterConfig: cfgFor([L(1)]), listings: new Map([[L(1), { currency: "MXN", timeZone: TZ }]]), executors: w.executors, clock: () => F.at(20), stripeAccountId: ACCT };
  assert.equal(compensationWorkerGate(base).ok, true);
  assert.deepEqual([...CLEANUP_EXECUTOR_KEYS].sort(), ["cancelPaymentIntent", "cancelReservation", "lookupPage", "retrieveAccount", "retrievePaymentIntent", "retrieveReservation"]);
  const cases = [
    [{ env: { ...ENV, VERCEL_ENV: "production" } }, "PRODUCTION_REFUSED"], [{ env: { MV_E7_COMPENSATION_WORKER: "enabled" } }, "ENVIRONMENT_NOT_ALLOWED"],
    [{ env: { VERCEL_ENV: "preview", MV_E7_CAPTURE_WORKER: "enabled" } }, "NOT_ENABLED"], [{ stripeAccountId: "sk_test_x" }, "STRIPE_ACCOUNT_REQUIRED"],
    [{ listings: new Map([[L(1), { currency: "MXN" }]]) }, "LISTING_TIME_ZONE_INVALID"], [{ listings: new Map([[L(1), { currency: "MXN", timeZone: "+07:00" }]]) }, "LISTING_TIME_ZONE_INVALID"],
    [{ listings: new Map([[L(1), { currency: "MXN", timeZone: "Mars/Olympus" }]]) }, "LISTING_TIME_ZONE_INVALID"],
    [{ listings: new Map([[L(1), { currency: "USD", timeZone: TZ }]]) }, "LISTING_NOT_ALLOWLISTED"], [{ clock: undefined }, "CLOCK_REQUIRED"]
  ];
  for (const k of CLEANUP_EXECUTOR_KEYS) { const e = { ...w.executors }; delete e[k]; cases.push([{ executors: e }, "NO_EXECUTORS"]); }
  for (const extra of ["capturePaymentIntent", "refundPaymentIntent", "createRefund", "createReservation", "recordOfflineCharge", "notifyGuest", "createCheckoutSession"]) {
    cases.push([{ executors: { ...w.executors, [extra]: async () => { throw new Error("never"); } } }, "EXECUTOR_NOT_ALLOWED"]);
  }
  for (const [over, code] of cases) assert.equal(compensationWorkerGate({ ...base, ...over }).code, code, JSON.stringify(Object.keys(over)));
  const a = await captureFailed(w, 1, "P");
  const h = harness(w, [1]);
  for (const over of [{ env: { ...ENV, VERCEL_ENV: "production" } }, { executors: { ...w.executors, capturePaymentIntent: async () => 0 } }]) assert.equal((await h.step(over)).status, "refused");
  assert.deepEqual(w.calls, []);
  assert.equal((await opsOf(a.id, OPS.VOID))[0].state, "pending");
});

test("reservation_failed (Z): fresh PI proof -> exact void -> CONFIRMING strict canceled read -> row completed -> VOID_SUCCEEDED -> authorization_released", async () => {
  const w = world();
  const a = await reservationFailed(w, 2);
  const h = harness(w, [2]);
  const r = await h.step({ intentId: a.id });
  assert.equal(await state(a.id), "authorization_released", JSON.stringify(r.actions));
  assert.deepEqual(w.calls, ["ACCOUNT", `PI ${a.piId}`, `VOID ${a.piId}`, `PI ${a.piId}`]);
  const v = (await opsOf(a.id, OPS.VOID))[0];
  assert.deepEqual(w.voids, [{ id: a.piId, params: {}, key: v.payload.providerIdempotencyKey }]);
  assert.deepEqual([v.state, v.attempts], ["succeeded", 1]);
  assert.equal(await events(a.id, "VOID_SUCCEEDED"), 1);
  assert.equal(w.cancels.length, 0);
  assert.equal((await h.step({ intentId: a.id })).status, "idle");
});

test("capture_failed P / Z: two legs; 'cancelled' only after BOTH (void + host-cancel), each with confirming proof; capture rows untouched", async () => {
  for (const cls of ["P", "Z"]) {
    const w = world();
    const a = await captureFailed(w, 3, cls);
    const h = harness(w, [3], { start: cls === "Z" ? F.at(800) : F.at(20) });
    if (cls === "Z") assert.ok(h.clk.t > a.intent.payment.captureBefore, "void after the capture deadline stays valid");
    const cap0 = await snapCapture(a.id);
    await h.step({ intentId: a.id });
    assert.equal(await state(a.id), "capture_failed", cls);
    assert.deepEqual(await legs(a.id), [false, true], `${cls}: authorization leg only`);
    await h.step({ intentId: a.id });
    assert.equal(await state(a.id), "cancelled", cls);
    assert.deepEqual(await legs(a.id), [true, true]);
    assert.equal(w.voids.length, 1); assert.equal(w.cancels.length, 1);
    assert.deepEqual(w.cancels, [`/v1/reservations/${a.reservationId}/statuses/cancelled`]);
    assert.deepEqual(await snapCapture(a.id), cap0, `${cls}: capture rows never touched`);
    assert.equal((await opsOf(a.id, OPS.CANCEL))[0].state, "succeeded");
  }
});

test("capture_failed D: still-authorized -> owner case, ZERO writes; strict canceled -> authorization leg settled WITHOUT a void (linked event), then cancel", async () => {
  const w = world();
  const a = await captureFailed(w, 4, "D");
  const h = harness(w, [4]);
  const cap0 = await snapCapture(a.id);
  await h.step({ intentId: a.id });
  assert.equal(await state(a.id), "reconciliation_required");
  assert.equal(await reasonOf(a.id), "CAPTURE_SENT_BLOCKS_VOID");
  assert.equal(w.voids.length + w.cancels.length, 0);
  // canceled authorization (e.g. lapsed): settled from evidence, no void sent; the cancel needs the canceled proof
  const w2 = world();
  const b = await captureFailed(w2, 4, "D");
  w2.pis.get(b.piId).status = "canceled";
  const h2 = harness(w2, [4]);
  await h2.step({ intentId: b.id });
  assert.deepEqual(await legs(b.id), [false, true]);
  const ev = (await db.app.query("SELECT event_id FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id LIKE 'cw4-authgone:%'", [b.id])).rows;
  assert.equal(ev.length, 1);
  assert.equal(w2.voids.length, 0, "no void for an authorization that is already gone");
  await h2.step({ intentId: b.id });
  assert.equal(await state(b.id), "cancelled");
  assert.equal(w2.cancels.length, 1);
  assert.deepEqual(await snapCapture(a.id), cap0);
  assert.equal((await opsOf(b.id, OPS.VOID))[0].state, "pending", "the void row stays as a never-sent audit row");
});

test("external capture (another actor) -> owner case, never void / cancel / refund", async () => {
  for (const kind of ["reservation_failed", "capture_failed"]) {
    const w = world();
    const a = kind === "reservation_failed" ? await reservationFailed(w, 5) : await captureFailed(w, 5, "P");
    w.pis.get(a.piId).status = "succeeded";
    const h = harness(w, [5]);
    await h.step({ intentId: a.id });
    assert.equal(await state(a.id), "reconciliation_required", kind);
    assert.equal(await reasonOf(a.id), "CAPTURED_WHILE_VOIDING");
    assert.equal(w.voids.length + w.cancels.length, 0);
  }
  // capture during the cancel leg (authorization leg already settled)
  const w = world();
  const b = await captureFailed(w, 5, "P");
  const h = harness(w, [5]);
  await h.step({ intentId: b.id });
  w.pis.get(b.piId).status = "succeeded";
  await h.step({ intentId: b.id });
  assert.equal(await reasonOf(b.id), "CAPTURED_DURING_CANCELLATION");
  assert.equal(w.cancels.length, 0);
});

test("a provider reply alone never completes a leg; unknown -> reads only -> still authorized / still active -> fenced owner case; zero resends under repeated delivery", async () => {
  // void
  const w = world(); w.voidMode = "replyOnly";
  const a = await reservationFailed(w, 6);
  const h = harness(w, [6]);
  const r = await h.step({ intentId: a.id });
  assert.ok(r.actions.includes("VOID_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CANCELED"), JSON.stringify(r.actions));
  assert.equal(await state(a.id), "reservation_failed");
  assert.equal((await opsOf(a.id, OPS.VOID))[0].state, "outcome_unknown");
  w.voidMode = "ok";
  await h.until(a.id, isEnd, { max: 20 });
  assert.equal(await reasonOf(a.id), "VOID_UNRESOLVED_STILL_AUTHORIZED");
  assert.equal(await events(a.id, "RECONCILED_STILL_AUTHORIZED"), 0);
  for (let k = 0; k < 4; k++) { h.clk.t += 5 * MIN; await Promise.all([h.step(), h.step({ workerId: "cw2" })]); }
  assert.equal(w.voids.length, 1); assert.equal((await opsOf(a.id, OPS.VOID)).length, 1);
  // cancel
  const w2 = world(); w2.cancelMode = "replyOnly";
  const b = await captureFailed(w2, 6, "P");
  const h2 = harness(w2, [6]);
  await h2.step({ intentId: b.id });                         // void leg
  const r2 = await h2.step({ intentId: b.id });
  assert.ok(r2.actions.includes("RESERVATION_CANCEL_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CANCELLED"), JSON.stringify(r2.actions));
  w2.cancelMode = "ok";
  await h2.until(b.id, isEnd, { max: 20 });
  assert.equal(await reasonOf(b.id), "CANCEL_UNRESOLVED_STILL_ACTIVE");
  assert.equal(await events(b.id, "RECONCILED_RESERVATION_STILL_ACTIVE"), 0);
  for (let k = 0; k < 4; k++) { h2.clk.t += 5 * MIN; await Promise.all([h2.step(), h2.step({ workerId: "cw2" })]); }
  assert.equal(w2.cancels.length, 1); assert.equal((await opsOf(b.id, OPS.CANCEL)).length, 1);
});

test("error modes -> unknown (never *_FAILED from bare labels); if the provider DID act, reads reconcile it with the strict proof", async () => {
  let n = 0;
  for (const [mode, acted] of [["500", false], ["500Canceled", true], ["409", false], ["malformed", true], ["hang", false]]) {
    n += 1;
    const w = world(); w.voidMode = mode;
    const a = await reservationFailed(w, 7);
    const h = harness(w, [7]);
    const r = await h.step({ intentId: a.id, timeouts: SHORT });
    await settleLate(r);
    assert.ok(r.actions.some((x) => x.startsWith("VOID_OUTCOME_UNKNOWN:")), `${mode} ${JSON.stringify(r.actions)}`);
    w.voidMode = "ok";
    const end = await h.until(a.id, isEnd, { max: 20 });
    assert.equal(await events(a.id, "VOID_FAILED"), 0);
    assert.equal(end, acted ? "authorization_released" : "reconciliation_required", mode);
    assert.equal(w.voids.length, 1, mode);
  }
  for (const [mode, acted] of [["500", false], ["500Cancelled", true], ["hang", false]]) {
    const w = world(); w.cancelMode = mode;
    const a = await captureFailed(w, 7, "P");
    const h = harness(w, [7]);
    await h.step({ intentId: a.id });
    const r = await h.step({ intentId: a.id, timeouts: SHORT });
    await settleLate(r);
    assert.ok(r.actions.some((x) => x.startsWith("RESERVATION_CANCEL_OUTCOME_UNKNOWN:")), `${mode} ${JSON.stringify(r.actions)}`);
    w.cancelMode = "ok";
    const end = await h.until(a.id, isEnd, { max: 20 });
    assert.equal(await events(a.id, "RESERVATION_CANCEL_FAILED"), 0);
    assert.equal(end, acted ? "cancelled" : "reconciliation_required", mode);
    assert.equal(w.cancels.length, 1, mode);
  }
});

test("pending audit row of an already-settled leg: never claimed / sent by this worker (any scope, many steps)", async () => {
  const w = world();
  const a = await captureFailed(w, 8, "D");
  w.pis.get(a.piId).status = "canceled";
  const h = harness(w, [8]);
  await h.until(a.id, (st) => st === "cancelled", { max: 10 });
  const v = (await opsOf(a.id, OPS.VOID))[0];
  assert.deepEqual([v.state, v.attempts, v.dispatched_at], ["pending", 0, null]);
  for (let k = 0; k < 5; k++) { h.clk.t += 10 * MIN; await h.step(); await h.step({ intentId: a.id }); }
  const v2 = (await opsOf(a.id, OPS.VOID))[0];
  assert.deepEqual([v2.state, v2.attempts, v2.dispatched_at], ["pending", 0, null]);
  assert.equal(w.voids.length, 0);
});

test("SHARED CLAIM GAP (root review item): generic claimNextOperation can still claim the never-sent void audit row of a settled leg", { todo: "needs a shared void/cancel claim fence in operations.js (proposed, not made in this slice)" }, async () => {
  const w = world();
  const a = await captureFailed(w, 9, "D");
  w.pis.get(a.piId).status = "canceled";
  const h = harness(w, [9]);
  await h.until(a.id, (st) => st === "cancelled", { max: 10 });
  const v = (await opsOf(a.id, OPS.VOID))[0];
  // the invariant root asked for: an already-gone authorization's pending void row must be unclaimable by ANY sender
  const generic = await claimNextOperation(db.app, { workerId: "other-scope", now: h.clk.t, opTypes: [OPS.VOID], intentId: a.id });
  const any = await claimNextOperation(db.app, { workerId: "other-scope-2", now: h.clk.t, opId: v.id });
  assert.equal(generic, null, "generic void claim must be refused after the authorization leg settled");
  assert.equal(any, null);
});

test("pre-send fences, each independently -> no send; no event after a lost lease", async () => {
  const need = CLEANUP_DEFAULT_TIMEOUTS.writeCallMs + CLEANUP_LIMITS.sendMarginMs;
  const cases = [
    ["opHeld", async (h, a, op) => { await setOpLease(op.id, h.clk.t + 10 * MIN, "intruder"); }, "OPERATION_NOT_HELD"],
    ["opRoom", async (h, a, op) => { await setOpLease(op.id, h.clk.t + need); }, "OPERATION_LEASE_TOO_SHORT"],
    ["workHeld", async (h, a) => { await setWorkLease(a.id, h.clk.t + 10 * MIN, "intruder"); }, "WORK_LEASE_NOT_HELD"],
    ["workRoom", async (h, a, op) => { await setOpLease(op.id, h.clk.t + 10 * MIN); await setWorkLease(a.id, h.clk.t + need); }, "WORK_LEASE_TOO_SHORT"],
    ["version", async (h, a) => { await db.owner.query("UPDATE booking.intents SET version = version + 1 WHERE id = $1", [a.id]); }, "INTENT_CHANGED"],
    ["stale", async (h, a, op) => { h.clk.t += 6 * MIN; await setOpLease(op.id, h.clk.t + 10 * MIN); await setWorkLease(a.id, h.clk.t + 10 * MIN); }, "EVIDENCE_STALE"],
    ["budget", async (h) => { h.clk.m += CLEANUP_DEFAULT_TIMEOUTS.stepBudgetMs; }, "STEP_BUDGET"]
  ];
  for (const leg of ["void", "cancel"]) {
    for (const [name, tamper, code] of cases) {
      const w = world();
      const a = await captureFailed(w, 10, "P");
      const h = harness(w, [10]);
      if (leg === "cancel") await h.step({ intentId: a.id });
      const sends0 = w.voids.length + w.cancels.length;
      const r = await h.step({ intentId: a.id, monotonic: () => h.clk.m, hooks: { afterClaim: async (op) => tamper(h, a, op) } });
      assert.ok(r.actions.includes(`SEND_ABORTED:${code}`), `${leg}/${name} ${JSON.stringify(r.actions)}`);
      assert.equal(w.voids.length + w.cancels.length, sends0, `${leg}/${name}: no send`);
      if (name === "opHeld") assert.ok(r.actions.some((x) => x.startsWith("LEASE_LOST")), "no event after a lost op lease");
      if (name === "workHeld") {
        assert.equal(await events(a.id, leg === "void" ? "VOID_OUTCOME_UNKNOWN" : "RESERVATION_CANCEL_OUTCOME_UNKNOWN"), 0, "no event without the work lease");
      }
    }
  }
  // arrival reached between claim and send (local midnight in the listing zone): no send
  const w = world();
  const a = await captureFailed(w, 10, "P");
  const dayBefore = Date.parse(`${a.intent.from}T07:00:00Z`) - 2 * MIN;    // 23:58 local (UTC-7) the day before arrival
  const h = harness(w, [10], { start: dayBefore - 30 * MIN });
  await h.step({ intentId: a.id });
  h.clk.t = dayBefore;
  const r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => { h.clk.t += 3 * MIN; await setOpLease(op.id, h.clk.t + 10 * MIN); await setWorkLease(a.id, h.clk.t + 10 * MIN); } } });
  assert.ok(r.actions.includes("SEND_ABORTED:ARRIVAL"), JSON.stringify(r.actions));
  assert.equal(w.cancels.length, 0);
  // arrival already reached before any read: owner case, zero calls for the cancel leg
  const w3 = world();
  const c = await captureFailed(w3, 10, "P");
  const h3 = harness(w3, [10], { start: Date.parse(`${c.intent.from}T08:00:00Z`) });
  await h3.step({ intentId: c.id });                  // void leg is still valid after arrival
  await h3.step({ intentId: c.id });
  assert.equal(await reasonOf(c.id), "ARRIVAL_NOT_IN_FUTURE");
  assert.equal(w3.cancels.length, 0);
});

test("crash windows (after claim / send / confirming evidence / completion / before unknown settlement) -> reads + accepted planner; never a resend", async () => {
  const windows = [["afterClaim", "ok", "reconciliation_required", 0], ["afterSend", "ok", "authorization_released", 1], ["afterConfirmEvidence", "ok", "authorization_released", 1],
    ["afterComplete", "ok", "authorization_released", 1], ["beforeSettleUnknown", "500", "reconciliation_required", 1], ["beforeSettleUnknown", "500Canceled", "authorization_released", 1]];
  for (const [hook, mode, end, sends] of windows) {
    const w = world(); w.voidMode = mode;
    const a = await reservationFailed(w, 11);
    const h = harness(w, [11]);
    await assert.rejects(h.step({ intentId: a.id, hooks: { [hook]: async () => { throw new Error("crash"); } } }), /crash/, hook);
    w.voidMode = "ok";
    const trace = [];
    for (let k = 0; k < 30 && !isEnd(await state(a.id)); k++) { const r = await h.step({ intentId: a.id }); trace.push(...r.actions); await settleLate(r); h.clk.t += MIN; }
    assert.equal(await state(a.id), end, `${hook}/${mode} ${JSON.stringify(trace.slice(0, 12))} ${JSON.stringify((await opsOf(a.id, OPS.VOID)).map((o) => [o.state, o.error_code]))}`);
    assert.equal(w.voids.length, sends, `${hook}/${mode}`);
    assert.equal((await opsOf(a.id, OPS.VOID)).length, 1);
  }
});

test("races: another actor settles the leg / escalates during reads, or between work claim and maintenance -> the stale worker does nothing", async () => {
  // another actor escalates during the PI read: no claim, no send, no second escalation
  const w = world();
  const a = await captureFailed(w, 12, "P");
  const h = harness(w, [12]);
  let once = false;
  w.onPiRead = async () => { if (!once) { once = true; F.ok(await applyEvent(db.app, a.id, { type: "ESCALATE", id: "other-actor", code: "OWNER_REVIEW" }, { now: h.clk.t, actor: "reconciler" })); } };
  const r = await h.step({ intentId: a.id });
  assert.equal(await reasonOf(a.id), "OWNER_REVIEW");
  assert.equal(w.voids.length, 0, JSON.stringify(r.actions));
  // the intent leaves the phase after the work claim: its expired PI read row is untouched by maintenance
  const w2 = world();
  const b = await captureFailed(w2, 12, "P");
  const h2 = harness(w2, [12]);
  const rd = await requestRead(db.app, b.id, OPS.PI_READ, b.piId, { now: h2.clk.t - 5 * MIN });
  await claimNextOperation(db.app, { workerId: "x-old", now: h2.clk.t - 5 * MIN, opId: rd });
  const before0 = (await db.app.query("SELECT state, lease_worker_id, updated_at FROM booking.external_operations WHERE id = $1", [rd])).rows[0];
  await h2.step({ intentId: b.id, hooks: { beforeMaintenance: async () => { F.ok(await applyEvent(db.app, b.id, { type: "ESCALATE", id: "other-2", code: "OWNER_REVIEW" }, { now: h2.clk.t, actor: "reconciler" })); } } });
  assert.deepEqual((await db.app.query("SELECT state, lease_worker_id, updated_at FROM booking.external_operations WHERE id = $1", [rd])).rows[0], before0);
  assert.equal(w2.voids.length, 0);
  // two workers on one intent: one work claim, one send
  const w3 = world();
  const c = await reservationFailed(w3, 12);
  const h3 = harness(w3, [12]);
  const rs = await Promise.all([h3.step({ intentId: c.id }), h3.step({ intentId: c.id, workerId: "cw2" })]);
  assert.equal(rs.filter((x) => x.status === "worked").length, 1);
  assert.equal(w3.voids.length, 1);
});

test("a late void reply after its timeout is late evidence only, recorded after the unknown settlement; never an event", async () => {
  const w = world(); w.voidMode = "late";
  const a = await reservationFailed(w, 13);
  const h = harness(w, [13]);
  const r = await h.step({ intentId: a.id, timeouts: SHORT, hooks: { beforeSettleUnknown: async () => { w.releaseLate(); await new Promise((res) => setImmediate(res)); } } });
  await r.late;
  const v = (await opsOf(a.id, OPS.VOID))[0];
  assert.deepEqual([v.state, v.late_result_status], ["outcome_unknown", "succeeded"]);
  assert.equal(await events(a.id, "VOID_SUCCEEDED"), 0);
  assert.equal(await state(a.id), "reservation_failed");
  await h.until(a.id, isEnd, { max: 20 });
  assert.equal(await state(a.id), "authorization_released", "reconciled from a fresh strict canceled read");
  assert.equal(w.voids.length, 1);
});

test("protected reservation ids -> owner case, zero provider calls; ref not echoed -> by-ref lookup proves identity", async () => {
  for (const rid of ["70636076", "71045356", "71072615", "71081885"]) {
    const w = world();
    const a = await captureFailed(w, 14, "P", { rid: Number(rid) });
    const h = harness(w, [14]);
    await h.step({ intentId: a.id });
    assert.equal(await reasonOf(a.id), "PROTECTED_RESERVATION_ID", rid);
    assert.deepEqual(w.calls, []);
  }
  const w = world();
  const b = await captureFailed(w, 14, "P", { noRef: true });
  const h = harness(w, [14]);
  await h.until(b.id, isEnd, { max: 6 });
  assert.equal(await state(b.id), "cancelled");
  assert.ok(w.count("LOOKUP") >= 2, "lookup before the cancel and in the confirming read");
});

test("bounded: hangs on every call; failing reads exhaust into a durable owner case", async () => {
  for (const k of ["account", "pi", "res", "void", "cancel"]) {
    const w = world();
    const a = await captureFailed(w, 15, "P");
    const h = harness(w, [15]);
    if (k === "res" || k === "cancel") await h.step({ intentId: a.id });
    if (k === "account") w.accountMode = "hang";
    if (k === "pi") w.piMode = "hang";
    if (k === "res") w.retrieveMode = "hang";
    if (k === "void") w.voidMode = "hang";
    if (k === "cancel") w.cancelMode = "hang";
    const t0 = Date.now();
    await h.step({ intentId: a.id, timeouts: SHORT });
    assert.ok(Date.now() - t0 < 3000, k);
  }
  const w = world(); w.piMode = "500";
  const a = await reservationFailed(w, 15);
  const h = harness(w, [15]);
  await h.until(a.id, isEnd, { max: 80, advanceMs: 10 * MIN });
  assert.equal(await reasonOf(a.id), "CLEANUP_READS_EXHAUSTED");
  assert.ok(w.count("PI ") <= CLEANUP_LIMITS.maxReadsPerType);
  assert.equal(w.voids.length, 0);
});

test("out-of-scope rows untouched (snapshots) and > 100 noise rows never starve the worker (unscoped steps)", async () => {
  const other = L(90);
  for (let k = 0; k < 105; k++) {
    const r = await F.authorized(db.app, { listingId: other, from: addDays("2028-01-01", 5 * k), to: addDays("2028-01-01", 5 * k + 4) });
    F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  }
  // out-of-scope on the CONFIGURED listing: capture-phase, paid (offline charge pending), escalated cleanup intent
  const cfgL = L(91);
  const capPhase = await F.reserved(db.app, { listingId: cfgL, from: "2029-09-01", to: "2029-09-05" });
  const paid = await F.captured(db.app, { listingId: cfgL, from: "2029-10-01", to: "2029-10-05" });
  const w0 = world();
  const esc = await captureFailed(w0, 91, "P");
  F.ok(await applyEvent(db.app, esc.id, { type: "ESCALATE", id: "pre", code: "OWNER_REVIEW" }, { now: F.at(9), actor: "reconciler" }));
  const outIds = [capPhase.id, paid.id, esc.id];
  const snap = async () => ({
    ops: (await db.app.query("SELECT id, state, attempts, updated_at FROM booking.external_operations WHERE intent_id = ANY($1) OR intent_id IN (SELECT id FROM booking.intents WHERE listing_id = $2) ORDER BY id", [outIds, other])).rows,
    intents: (await db.app.query("SELECT id, state, version FROM booking.intents WHERE id = ANY($1) OR listing_id = $2 ORDER BY id", [outIds, other])).rows
  });
  const s0 = await snap();
  const w = world();
  const t1 = await reservationFailed(w, 91);
  const t2 = await captureFailed(w, 91, "P");
  const h = harness(w, [91], { start: F.at(600) });
  for (let k = 0; k < 30 && !((await state(t1.id)) === "authorization_released" && (await state(t2.id)) === "cancelled"); k++) { h.clk.t += MIN; const r = await h.step(); await settleLate(r); }
  assert.equal(await state(t1.id), "authorization_released");
  assert.equal(await state(t2.id), "cancelled");
  assert.deepEqual(await snap(), s0, "no out-of-scope row was touched");
});

test("strict PI proofs only: requires_payment_method never settles the authorization; a canceled-but-refund-fields shape (R-REFUND) is an owner case", async () => {
  for (const cls of ["D", "P"]) {
    const w = world();
    const a = await captureFailed(w, 16, cls);
    w.pis.get(a.piId).status = "requires_payment_method";
    const h = harness(w, [16]);
    await h.step({ intentId: a.id });
    assert.equal(await state(a.id), "reconciliation_required", cls);
    assert.deepEqual(await legs(a.id), [false, false], `${cls}: no leg settled from requires_payment_method`);
    assert.equal(w.voids.length + w.cancels.length, 0);
  }
  // the void DID happen but the charge shows refund fields: the planner's piGoneProof would accept it; this worker refuses
  const w = world(); w.voidMode = "500Canceled";
  const b = await reservationFailed(w, 16);
  w.pis.get(b.piId).refundFieldsOnCancel = true;
  const h = harness(w, [16]);
  await h.step({ intentId: b.id });
  await h.until(b.id, isEnd, { max: 20 });
  assert.equal(await reasonOf(b.id), "VOID_PROOF_NOT_STRICT");
  assert.equal(await events(b.id, "VOID_SUCCEEDED"), 0);
  assert.equal(w.voids.length, 1);
});

test("race: another actor settles the authorization leg (same state, new version) during the worker's PI read -> the stale owner-case escalation is fenced out", async () => {
  const w = world();
  const a = await captureFailed(w, 17, "D");                // the worker will decide CAPTURE_SENT_BLOCKS_VOID from its read
  const h = harness(w, [17]);
  let once = false;
  w.onPiRead = async () => {
    if (once) return; once = true;
    const p = w.pis.get(a.piId);
    const canceled = paymentIntentProofObservationV3({ ...w.piObj({ ...p, status: "canceled" }) }, { accountVerified: true });
    await F.piStatus(db.app, a.id, a.piId, "canceled", canceled, (h.clk.t - F.T0) / MIN);
    F.ok(await applyEvent(db.app, a.id, { type: "RECONCILED_AUTHORIZATION_GONE", id: "other-actor-authgone" }, { now: h.clk.t, actor: "reconciler" }));
  };
  const r = await h.step({ intentId: a.id });
  assert.ok(r.actions.includes("ESCALATE!STALE_OUT_OF_SCOPE"), JSON.stringify(r.actions));
  assert.equal(await state(a.id), "capture_failed");
  assert.deepEqual(await legs(a.id), [false, true], "the other actor's settlement stands; nothing escalated");
  assert.equal(await events(a.id, "ESCALATE"), 0);
});
