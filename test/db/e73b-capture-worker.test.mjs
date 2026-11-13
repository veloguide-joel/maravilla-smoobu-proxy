// Stage E7.3b — offline capture worker on a throwaway local PostgreSQL with FAKE Stripe + Hostaway executors (no network,
// no SDK, no credentials). Runtime code runs as mv_booking_app; db.owner is used ONLY to tamper leases in guard tests.
// The clock is a test-controlled function; hang tests use tiny (caller-shortened) per-call timeouts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead } from "../../lib/booking-db/operations.js";
import {
  runCaptureStep, captureWorkerGate, CAPTURE_EXECUTOR_KEYS, CAPTURE_LIMITS, CAPTURE_DEFAULT_TIMEOUTS, PROTECTED_HOSTAWAY_RESERVATION_IDS, OPS, _internal
} from "../../lib/booking-db/capture-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { paymentIntentProofObservationV3 } from "../../lib/checkout/capture-proof.js";
import { loadRecoveryFacts, applyRecoveryPlan } from "../../lib/booking-db/recovery.js";
import { planRecovery } from "../../lib/checkout/recovery-plan.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" });
const ACCT = "acct_1TestCaptureWorker";
const REF_FIELD = 777003;
const L = (n) => 880000 + n;
const MIN = F.MIN;
const SHORT = Object.freeze({ readCallMs: 40, captureCallMs: 60 });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const httpError = (statusCode) => Object.assign(new Error(`stripe ${statusCode}`), { statusCode });

// ---------- fake Stripe + Hostaway world ----------
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), captures: [], signals: [], captureMode: "ok", piMode: "ok", accountMode: "ok",
    retrieveMode: "ok", lookupMode: "ok", piTamper: null, resTamper: null, onCapture: null, onPiRead: null, onResRead: null };
  const hang = (signal) => { w.signals.push(signal); return new Promise(() => {}); };
  w.piObj = (p) => {
    const cap = p.status === "succeeded";
    return {
      object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount,
      amount_received: cap ? p.received : 0, amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "mxn",
      metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
      latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: cap, amount: p.amount,
        amount_captured: cap ? p.received : 0, amount_refunded: 0, currency: "mxn", livemode: false,
        payment_method_details: { card: { capture_before: p.captureBeforeSec } } }
    };
  };
  const doCapture = (p, amount) => { p.status = "succeeded"; p.received = amount; };
  const full = (r) => {
    const o = { id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate,
      totalPrice: r.totalPrice, currency: r.currency, status: r.status };
    if (!r.noRef) o.customFieldValues = [{ customFieldId: REF_FIELD, value: r.ref }];
    return o;
  };
  w.executors = {
    retrieveAccount: async (o = {}) => {
      w.calls.push("ACCOUNT");
      if (w.accountMode === "hang") return hang(o.signal);
      if (w.accountMode === "fail") throw httpError(500);
      return { object: "account", id: w.accountMode === "other" ? "acct_1SomebodyElse" : ACCT };
    },
    retrievePaymentIntent: async (id, params, o = {}) => {
      assert.deepEqual(params, { expand: ["latest_charge"] });
      w.calls.push(`PI ${id}`);
      if (w.onPiRead) await w.onPiRead(id);
      if (w.piMode === "hang") return hang(o.signal);
      if (w.piMode === "500") throw httpError(500);
      if (w.piMode === "malformed") return { object: "payment_intent" };
      const obj = w.piObj(w.pis.get(id));
      if (w.piTamper) w.piTamper(obj);
      return obj;
    },
    capturePaymentIntent: async (id, params, o = {}) => {
      w.calls.push(`CAPTURE ${id}`);
      w.captures.push({ id, params: JSON.parse(JSON.stringify(params)), key: o.idempotencyKey });
      w.signals.push(o.signal);
      const p = w.pis.get(id);
      if (w.onCapture) await w.onCapture(id);
      switch (w.captureMode) {
        case "ok": doCapture(p, params.amount_to_capture); return w.piObj(p);
        case "replyOnly": return { ...w.piObj(p), status: "succeeded" };              // positive-looking reply, nothing captured
        case "replyNotSucceeded": return w.piObj(p);                                   // a 200 reply whose status is still requires_capture
        case "hang": return hang(o.signal);
        case "hangCaptured": doCapture(p, params.amount_to_capture); return hang(o.signal);
        case "late": return new Promise((resolve) => { w.releaseLate = () => { doCapture(p, params.amount_to_capture); resolve(w.piObj(p)); }; });
        case "500": throw httpError(500);
        case "500Captured": doCapture(p, params.amount_to_capture); throw httpError(500);
        case "409": throw httpError(409);
        case "429": throw httpError(429);
        case "402": throw httpError(402);
        case "400": throw httpError(400);
        case "malformed": doCapture(p, params.amount_to_capture); return { object: "payment_intent" };
        case "partial": doCapture(p, params.amount_to_capture - 100); return w.piObj(p);
        default: throw new Error(`mode ${w.captureMode}`);
      }
    },
    retrieveReservation: async (req, o = {}) => {
      w.calls.push(`RES ${req.path}`);
      if (w.onResRead) await w.onResRead();
      if (w.retrieveMode === "hang") return hang(o.signal);
      if (w.retrieveMode === "500") return { httpStatus: 500, json: null };
      const r = w.res.get(Number(/\/reservations\/(\d+)$/.exec(req.path)[1]));
      if (!r) return { httpStatus: 404, json: { status: "fail" } };
      const obj = full(r);
      if (w.resTamper) w.resTamper(obj);
      return { httpStatus: 200, json: { status: "success", result: obj } };
    },
    lookupPage: async (req, o = {}) => {
      w.calls.push(`LOOKUP ${req.query.listingId}${req.query.afterId ? " after" : ""}`);
      if (w.lookupMode === "hang") return hang(o.signal);
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      const items = [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate)
        .map((r) => ({ ...full({ ...r, noRef: false }) }));
      if (w.lookupMode === "duplicate" && items.length) items.push({ ...items[0], id: items[0].id + 1 });
      if (w.lookupMode === "empty") items.length = 0;
      return { httpStatus: 200, json: { status: "success", result: items } };
    }
  };
  w.count = (prefix) => w.calls.filter((c) => c.startsWith(prefix)).length;
  return w;
}

const cfgFor = (ids) => validateAdapterConfig({ allowedListingIds: ids, refFieldId: REF_FIELD, channelId: 2000, currency: "MXN" });

/** reservation_confirmed intent (E3 fixtures) with an explicit Hostaway reservation id. */
async function reservedWith(stay, rid) {
  const d = await F.dispatched(db.app, stay);
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(7), actor: "worker" }));
  return { ...d, reservationId: rid };
}

/** A reservation_confirmed intent + matching provider state in the fake world. */
async function capIntent(w, n, { from = "2026-12-20", to = "2026-12-24", rid = null, noRef = false } = {}) {
  const stay = { listingId: L(n), from, to };
  const r = rid ? await reservedWith(stay, rid) : await F.reserved(db.app, stay);
  const intent = await loadIntent(db.app, r.id);
  const pa = (await db.app.query("SELECT id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [r.id])).rows[0].id;
  w.pis.set(r.piId, { id: r.piId, intentId: r.id, attemptId: pa, status: "requires_capture", amount: 576000, received: 0,
    chargeId: `ch_test_${r.id.slice(0, 8)}`, captureBeforeSec: intent.payment.captureBefore / 1000 });
  w.res.set(Number(r.reservationId), { id: Number(r.reservationId), listingMapId: L(n), arrivalDate: from, departureDate: to, totalPrice: 5760,
    currency: "MXN", status: "new", ref: intent.ref, noRef });
  const capOp = (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [r.id, OPS.CAPTURE])).rows[0];
  return { ...r, ref: intent.ref, paymentAttemptId: pa, intent, capOpId: capOp.id };
}

/** Wait for late handlers that can finish (a hung fake never resolves: bounded wait). */
const settleLate = (r) => Promise.race([r.late, new Promise((res) => setTimeout(res, 200))]);

function harness(w, ns, { start = F.at(10) } = {}) {
  const ids = ns.map(L);
  const clk = { t: start, m: 0 };
  const h = {
    clk, w,
    opts: (extra = {}) => ({ workerId: "cw1", env: ENV, adapterConfig: cfgFor(ids), listings: new Map(ids.map((id) => [id, { currency: "MXN" }])),
      executors: w.executors, clock: () => clk.t, stripeAccountId: ACCT, ...extra }),
    step: (extra = {}) => runCaptureStep(db.app, h.opts(extra)),
    until: async (intentId, pred, { max = 40, advanceMs = MIN, extra = {} } = {}) => {
      for (let k = 0; k < max; k++) {
        const st = (await loadIntent(db.app, intentId)).status;
        if (pred(st)) return st;
        const r = await h.step({ intentId, ...extra });
        await settleLate(r);
        clk.t += advanceMs;
      }
      assert.fail(`not reached after ${max} steps: ${(await loadIntent(db.app, intentId)).status}`);
    }
  };
  return h;
}

const opsOf = async (id, opType) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, opType])).rows;
const events = async (id, type) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, type]);
const escalations = async (id) => (await db.app.query("SELECT event_id FROM booking.intent_applied_events WHERE intent_id = $1 ORDER BY event_id", [id])).rows.map((r) => r.event_id);
const reasonOf = async (id) => (await db.app.query("SELECT reason_code FROM booking.intents WHERE id = $1", [id])).rows[0].reason_code;
const isEnd = (st) => ["payment_captured", "reconciliation_required"].includes(st);
/** The single capture row is never re-created / re-claimed, and the provider saw at most `sends` capture calls. */
async function oneCaptureRow(w, id, sends) {
  assert.equal((await opsOf(id, OPS.CAPTURE)).length, 1, "exactly one capture row, ever");
  assert.equal(w.captures.filter((c) => c.id === w.pis.get([...w.pis.keys()].find((k) => w.pis.get(k).intentId === id)).id).length, sends);
}
const capturesOf = (w, piId) => w.captures.filter((c) => c.id === piId).length;
/** Owner-only lease tampering (guard tests). */
const setOpLease = (opId, untilMs, worker = null) => db.owner.query(
  `UPDATE booking.external_operations SET lease_until = $2${worker ? ", lease_worker_id = $3" : ""} WHERE id = $1`, worker ? [opId, new Date(untilMs), worker] : [opId, new Date(untilMs)]);
const setWorkLease = (intentId, untilMs, worker = null) => db.owner.query(
  `UPDATE booking.intent_work SET work_lease_until = $2${worker ? ", work_worker_id = $3" : ""} WHERE intent_id = $1`, worker ? [intentId, new Date(untilMs), worker] : [intentId, new Date(untilMs)]);

// =============================================================================================
test("gate: production refused, explicit dev/preview flag, exact account / listings / currency / adapter config, EXACT executor keys", async () => {
  const w = world();
  const base = { env: ENV, adapterConfig: cfgFor([L(1)]), listings: new Map([[L(1), { currency: "MXN" }]]), executors: w.executors, clock: () => F.at(10), stripeAccountId: ACCT };
  assert.equal(captureWorkerGate(base).ok, true);
  assert.deepEqual([...CAPTURE_EXECUTOR_KEYS].sort(), ["capturePaymentIntent", "lookupPage", "retrieveAccount", "retrievePaymentIntent", "retrieveReservation"]);
  const cases = [
    [{ env: undefined }, "ENV_REQUIRED"],
    [{ env: { ...ENV, VERCEL_ENV: "production" } }, "PRODUCTION_REFUSED"],
    [{ env: { MV_E7_CAPTURE_WORKER: "enabled" } }, "ENVIRONMENT_NOT_ALLOWED"],
    [{ env: { VERCEL_ENV: "preview", MV_E7_CAPTURE_WORKER: "1" } }, "NOT_ENABLED"],
    [{ env: { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" } }, "NOT_ENABLED"],
    [{ stripeAccountId: undefined }, "STRIPE_ACCOUNT_REQUIRED"], [{ stripeAccountId: "acct_" }, "STRIPE_ACCOUNT_REQUIRED"], [{ stripeAccountId: "sk_test_x" }, "STRIPE_ACCOUNT_REQUIRED"],
    [{ adapterConfig: { allowedListingIds: [] } }, "ADAPTER_CONFIG_INVALID"],
    [{ listings: new Map() }, "LISTINGS_REQUIRED"], [{ listings: [[L(1), { currency: "MXN" }]] }, "LISTINGS_REQUIRED"],
    [{ listings: new Map([[L(2), { currency: "MXN" }]]) }, "LISTING_NOT_ALLOWLISTED"],
    [{ listings: new Map([[L(1), { currency: "USD" }]]) }, "LISTING_NOT_ALLOWLISTED"],
    [{ listings: new Map([[L(1), {}]]) }, "LISTING_NOT_ALLOWLISTED"],
    [{ executors: undefined }, "NO_EXECUTORS"],
    [{ clock: undefined }, "CLOCK_REQUIRED"], [{ clock: () => Number.NaN }, "CLOCK_REQUIRED"]
  ];
  for (const k of CAPTURE_EXECUTOR_KEYS) { const e = { ...w.executors }; delete e[k]; cases.push([{ executors: e }, "NO_EXECUTORS"]); }
  for (const extra of ["voidPaymentIntent", "cancelPaymentIntent", "refundPaymentIntent", "createRefund", "recordOfflineCharge", "notifyGuest",
    "sendNotification", "createReservation", "cancelReservation", "createCheckoutSession", "pricing"]) {
    cases.push([{ executors: { ...w.executors, [extra]: async () => { throw new Error("never"); } } }, "EXECUTOR_NOT_ALLOWED"]);
  }
  for (const [over, code] of cases) assert.equal(captureWorkerGate({ ...base, ...over }).code, code, JSON.stringify(Object.keys(over)));
  // a refused step touches nothing
  const a = await capIntent(w, 1);
  const h = harness(w, [1]);
  for (const over of [{ env: { ...ENV, VERCEL_ENV: "production" } }, { executors: { ...w.executors, voidPaymentIntent: async () => 0 } }, { workerId: "bad id!" }]) {
    const r = await h.step(over);
    assert.equal(r.status, "refused");
  }
  assert.deepEqual(w.calls, []);
  assert.equal((await opsOf(a.id, OPS.CAPTURE))[0].state, "pending");
});

test("happy initial capture: fresh reads -> exact request -> claim -> capture -> CONFIRMING READ -> completion -> fenced CAPTURE_SUCCEEDED; offline charge only queued", async () => {
  const w = world();
  const a = await capIntent(w, 2);
  const h = harness(w, [2]);
  const r = await h.step({ intentId: a.id });
  assert.equal(r.status, "worked");
  assert.deepEqual(w.calls, [`RES /reservations/${a.reservationId}`, "ACCOUNT", `PI ${a.piId}`, `CAPTURE ${a.piId}`, `PI ${a.piId}`], "confirming PI read after the reply");
  const op = (await opsOf(a.id, OPS.CAPTURE))[0];
  assert.deepEqual(w.captures, [{ id: a.piId, params: { amount_to_capture: 576000, expand: ["latest_charge"] }, key: op.payload.providerIdempotencyKey }]);
  assert.equal(op.payload.providerIdempotencyKey, `cap:${a.id}:${a.piId}`);
  assert.deepEqual([op.state, op.result_ref, op.attempts], ["succeeded", `ch_test_${a.id.slice(0, 8)}`, 1]);
  assert.ok(op.dispatched_at, "dispatch persisted (by the claim) before the send");
  const i = await loadIntent(db.app, a.id);
  assert.equal(i.status, "payment_captured");
  assert.equal(i.payment.capturedMinor, 576000);
  assert.deepEqual(await escalations(a.id).then((x) => x.filter((e) => e.startsWith("op-outcome:"))), [`op-outcome:${op.id}`]);
  const och = await opsOf(a.id, "hostaway.record_offline_charge");
  assert.deepEqual(och.map((o) => [o.state, o.dispatched_at]), [["pending", null]], "one offline charge queued, never executed");
  const ev = (await db.app.query(`SELECT e.observed ->> 'proofVersion' AS v, e.status FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
     WHERE e.intent_id = $1 AND r.op_type = $2 ORDER BY e.observed_at, e.id`, [a.id, OPS.PI_READ])).rows;
  assert.deepEqual(ev.map((x) => x.status).sort(), ["requires_capture", "succeeded"]);
  assert.ok(ev.every((x) => x.v === "pi-proof-v3"), JSON.stringify(ev));
  // nothing more to do for this worker
  const r2 = await h.step({ intentId: a.id });
  assert.equal(r2.status, "idle");
  assert.equal(w.count("CAPTURE"), 1);
});

test("ref not echoed by the by-id read: a by-ref lookup with the full identity is required; duplicate / missing ref never proves identity", async () => {
  const w = world();
  const a = await capIntent(w, 3, { noRef: true });
  const h = harness(w, [3]);
  await h.step({ intentId: a.id });
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  assert.deepEqual(w.calls.slice(0, 2), [`RES /reservations/${a.reservationId}`, `LOOKUP ${L(3)}`]);
  for (const [mode, code] of [["duplicate", "DUPLICATE_BOOKING_REF"], ["empty", "RESERVATION_REF_NOT_PROVEN"]]) {
    const w2 = world(); w2.lookupMode = mode;
    const b = await capIntent(w2, 3, { noRef: true, from: mode === "duplicate" ? "2027-01-10" : "2027-01-20", to: mode === "duplicate" ? "2027-01-14" : "2027-01-24" });
    const h2 = harness(w2, [3]);
    await h2.step({ intentId: b.id });
    assert.equal((await loadIntent(db.app, b.id)).status, "reconciliation_required");
    assert.equal(await reasonOf(b.id), code);
    assert.equal(w2.count("CAPTURE"), 0);
    assert.equal((await opsOf(b.id, OPS.CAPTURE))[0].state, "pending", "pending row retained as a manual case");
  }
});

test("a positive-looking capture reply alone is NEVER success: unknown, then reads; still authorized -> owner case, never a retry (repeated delivery)", async () => {
  const w = world(); w.captureMode = "replyOnly";
  const a = await capIntent(w, 4);
  const h = harness(w, [4]);
  const r = await h.step({ intentId: a.id });
  assert.ok(r.actions.includes("CAPTURE_OUTCOME_UNKNOWN:CONFIRM_READ_NOT_CAPTURED"), JSON.stringify(r.actions));
  assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown");
  assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 0);
  assert.equal(await events(a.id, "CAPTURE_FAILED"), 0);
  // reads only >= dispatch + 2 min
  const op = (await opsOf(a.id, OPS.CAPTURE))[0];
  const before = w.count("PI ");
  const r1 = await h.step({ intentId: a.id });
  assert.ok(r1.actions.includes("WAIT:EVIDENCE_FRESHNESS"), JSON.stringify(r1.actions));
  assert.equal(w.count("PI "), before);
  w.captureMode = "ok";       // even if a send were attempted it would now "work": it must never happen
  await h.until(a.id, isEnd, { max: 20 });
  assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required");
  assert.equal(await reasonOf(a.id), "CAPTURE_STILL_AUTHORIZED_UNRESOLVED");
  assert.equal(await events(a.id, "RECONCILED_STILL_AUTHORIZED"), 0, "planner's still-authorized event intercepted");
  assert.ok(new Date(op.dispatched_at).getTime() + 2 * MIN <= Math.min(...(await db.app.query(
    `SELECT e.observed_at FROM booking.provider_evidence e JOIN booking.external_operations r ON r.id = e.read_operation_id
      WHERE e.intent_id = $1 AND r.op_type = $2 AND e.observed_at > $3`, [a.id, OPS.PI_READ, op.dispatched_at])).rows.map((x) => new Date(x.observed_at).getTime())));
  // repeated delivery: more still-authorized evidence, concurrent workers, many steps — no new key, row or send
  await F.piStatus(db.app, a.id, a.piId, "requires_capture", {}, 400);
  for (let k = 0; k < 5; k++) {
    h.clk.t += 5 * MIN;
    await Promise.all([h.step(), h.step({ workerId: "cw2" })]);
  }
  await oneCaptureRow(w, a.id, 1);
  assert.equal(capturesOf(w, a.piId), 1);
  assert.deepEqual(new Set(w.captures.map((c) => c.key)).size, 1);
});

test("timeout / 5xx / 409 / 429 / 4xx / malformed / partial / unusable confirming read -> unknown + CAPTURE_OUTCOME_UNKNOWN, never CAPTURE_FAILED; read-only recovery", async () => {
  const modes = [
    ["500", false], ["500Captured", true], ["409", false], ["429", false], ["402", false], ["400", false], ["malformed", true],
    ["hangCaptured", true], ["hang", false], ["partial", "partial"], ["confirmRead500", true], ["confirmReadMalformed", true]
  ];
  let n = 0;
  for (const [mode, captured] of modes) {
    n += 1;
    const w = world();
    w.captureMode = mode.startsWith("confirmRead") ? "ok" : mode;
    const a = await capIntent(w, 5, { from: addDays("2027-02-01", 6 * n), to: addDays("2027-02-01", 6 * n + 4) });
    const h = harness(w, [5]);
    if (mode.startsWith("confirmRead")) w.onCapture = async () => { w.piMode = mode === "confirmRead500" ? "500" : "malformed"; };
    const r = await h.step({ intentId: a.id, timeouts: SHORT });
    await settleLate(r);
    assert.ok(r.actions.some((x) => x.startsWith("CAPTURE_OUTCOME_UNKNOWN:")), `${mode}: ${JSON.stringify(r.actions)}`);
    assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown", mode);
    assert.equal((await opsOf(a.id, OPS.CAPTURE))[0].state, "outcome_unknown", mode);
    w.piMode = "ok"; w.onCapture = null; w.captureMode = "ok";
    const end = await h.until(a.id, (st) => isEnd(st) || st === "capture_unknown_inconclusive", { max: 25 });
    assert.equal(await events(a.id, "CAPTURE_FAILED"), 0, mode);
    if (captured === true) {
      assert.equal(end, "payment_captured", mode);
      assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1, mode);
    } else {
      assert.equal(end, "reconciliation_required", mode);
    }
    await oneCaptureRow(w, a.id, 1);
  }
});

test("pre-send proof bindings: malformed / missing / contradicting PI, account or reservation data -> owner case, pending row retained, ZERO captures", async () => {
  const piCases = [
    ["livemode", (o) => { o.livemode = true; }], ["metaIntent", (o) => { o.metadata.mv_intent_id = "00000000-0000-4000-8000-000000000000"; }],
    ["metaAttempt", (o) => { o.metadata.mv_payment_attempt_id = "00000000-0000-4000-8000-000000000000"; }],
    ["captureMethod", (o) => { o.capture_method = "automatic"; }], ["amount", (o) => { o.amount = 1; }], ["currency", (o) => { o.currency = "usd"; }],
    ["noCurrency", (o) => { delete o.currency; }], ["status", (o) => { o.status = "requires_payment_method"; }],
    ["capturable", (o) => { o.amount_capturable = 100; }], ["notExpanded", (o) => { o.latest_charge = o.latest_charge.id; }],
    ["chargeCaptured", (o) => { o.latest_charge.captured = true; }], ["chargeNotPaid", (o) => { o.latest_charge.paid = false; }],
    ["captureBefore", (o) => { o.latest_charge.payment_method_details.card.capture_before += 60; }],
    ["noCaptureBefore", (o) => { delete o.latest_charge.payment_method_details; }], ["chargeCurrency", (o) => { delete o.latest_charge.currency; }],
    ["chargePi", (o) => { o.latest_charge.payment_intent = "pi_test_other"; }], ["chargeLive", (o) => { o.latest_charge.livemode = true; }],
    ["received", (o) => { o.amount_received = 5; }]
  ];
  const resCases = [
    ["listing", (o) => { o.listingMapId = L(99); }, "RESERVATION_PROOF_CONTRADICTION"], ["arrival", (o) => { o.arrivalDate = "2026-12-21"; }, "RESERVATION_PROOF_CONTRADICTION"],
    ["amount", (o) => { o.totalPrice = 5000; }, "RESERVATION_PROOF_CONTRADICTION"], ["currencyUSD", (o) => { o.currency = "USD"; }, "RESERVATION_PROOF_CONTRADICTION"],
    ["cancelled", (o) => { o.status = "cancelled"; }, "RESERVATION_PROOF_CONTRADICTION"], ["modified", (o) => { o.status = "modified"; }, "RESERVATION_PROOF_CONTRADICTION"], ["ownerStay", (o) => { o.status = "ownerStay"; }, "RESERVATION_PROOF_CONTRADICTION"],
    ["otherRef", (o) => { o.customFieldValues[0].value = "MV-ZZZZZZ"; }, "RESERVATION_PROOF_CONTRADICTION"],
    ["otherId", (o) => { o.id += 1; }, "RESERVATION_READ_CONTRADICTS_REQUEST"]
  ];
  let n = 0;
  const run = async (setup, expectCode) => {
    n += 1;
    const w = world();
    const a = await capIntent(w, 6, { from: addDays("2027-06-01", 6 * n), to: addDays("2027-06-01", 6 * n + 4) });
    setup(w);
    const h = harness(w, [6]);
    await h.step({ intentId: a.id });
    assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required", expectCode);
    if (expectCode) assert.equal(await reasonOf(a.id), expectCode);
    assert.equal(w.count("CAPTURE"), 0, expectCode);
    const op = (await opsOf(a.id, OPS.CAPTURE))[0];
    assert.deepEqual([op.state, op.dispatched_at], ["pending", null], "pending row retained (no auto-supersede)");
    return a;
  };
  for (const [name, t] of piCases) {
    const a = await run((w) => { w.piTamper = t; }, null);
    assert.match(await reasonOf(a.id), /^PRE_CAPTURE_/, name);
  }
  await run((w) => { w.accountMode = "other"; }, "STRIPE_ACCOUNT_MISMATCH");
  for (const [, t, code] of resCases) await run((w) => { w.resTamper = t; }, code);
  // a missing reservation currency is not normalizable: never evidence, never a send; bounded reads -> durable case
  n += 1;
  const w = world(); w.resTamper = (o) => { delete o.currency; };
  const a = await capIntent(w, 6, { from: addDays("2027-06-01", 6 * n), to: addDays("2027-06-01", 6 * n + 4) });
  const h = harness(w, [6]);
  await h.until(a.id, isEnd, { max: 80, advanceMs: 10 * MIN });
  assert.equal(await reasonOf(a.id), "PRE_CAPTURE_READS_EXHAUSTED");
  assert.equal(w.count("CAPTURE"), 0);
  assert.ok(w.count("RES ") <= CAPTURE_LIMITS.maxPreCaptureReadsPerType, `bounded: ${w.count("RES ")}`);
});

test("evidence freshness: old (pre-confirmation), stale and FUTURE evidence is never used; only reads executed now count", async () => {
  const w = world();
  const a = await capIntent(w, 7);
  const rid = String(a.reservationId);
  const good = { reservationId: rid, listingId: L(7), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000, currency: "MXN", status: "new", bookingRef: a.ref };
  await F.reservationStatus(db.app, a.id, rid, "found_active", good, 6);     // before the reservation confirmation (at 7)
  await F.reservationStatus(db.app, a.id, rid, "found_active", good, 30);    // in the FUTURE relative to the worker clock
  const h = harness(w, [7]);                                                  // clock at(10)
  await h.step({ intentId: a.id });
  assert.equal(w.count("RES "), 1, "the worker executed its own read");
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  // stale (> 5 min) evidence: a fresh read is executed instead
  const w2 = world();
  const b = await capIntent(w2, 7, { from: "2027-01-03", to: "2027-01-07" });
  await F.reservationStatus(db.app, b.id, String(b.reservationId), "found_active", { ...good, reservationId: String(b.reservationId), from: "2027-01-03", to: "2027-01-07", bookingRef: b.ref }, 10);
  const h2 = harness(w2, [7], { start: F.at(16) });
  await h2.step({ intentId: b.id });
  assert.equal(w2.count("RES "), 1);
  assert.equal((await loadIntent(db.app, b.id)).status, "payment_captured");
  // evidence going stale between claim and send -> no send, unknown
  const w3 = world();
  const c = await capIntent(w3, 7, { from: "2027-01-13", to: "2027-01-17" });
  const h3 = harness(w3, [7]);
  const r = await h3.step({ intentId: c.id, hooks: { afterClaim: async (op) => {
    h3.clk.t += 6 * MIN; await setOpLease(op.id, h3.clk.t + 10 * MIN); await setWorkLease(c.id, h3.clk.t + 10 * MIN);
  } } });
  assert.ok(r.actions.includes("SEND_ABORTED:EVIDENCE_STALE"), JSON.stringify(r.actions));
  assert.equal(w3.count("CAPTURE"), 0);
  assert.equal((await loadIntent(db.app, c.id)).status, "capture_unknown");
});

test("protected historical reservation ids are refused at every path (initial capture and capture_unknown recovery)", async () => {
  assert.deepEqual([...PROTECTED_HOSTAWAY_RESERVATION_IDS].sort(), ["70636076", "71045356", "71072615", "71081885"]);
  const ids = [70636076, 71045356, 71072615, 71081885];
  let n = 0;
  for (const rid of ids.slice(0, 2)) {
    n += 1;
    const w = world();
    const a = await capIntent(w, 8, { rid, from: addDays("2027-03-01", 6 * n), to: addDays("2027-03-01", 6 * n + 4) });
    const h = harness(w, [8]);
    await h.step({ intentId: a.id });
    assert.equal(await reasonOf(a.id), "PROTECTED_RESERVATION_ID");
    assert.deepEqual(w.calls, [], "no provider call at all");
  }
  for (const rid of ids.slice(2)) {
    n += 1;
    const w = world();
    const a = await capIntent(w, 8, { rid, from: addDays("2027-03-01", 6 * n), to: addDays("2027-03-01", 6 * n + 4) });
    // an earlier (non-worker) uncertain capture
    await F.runOp(db.app, a.id, OPS.CAPTURE, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
    F.ok(await applyEvent(db.app, a.id, { type: "CAPTURE_OUTCOME_UNKNOWN", id: `op-unknown:${a.capOpId}`, code: "TIMEOUT" }, { now: F.at(8) }));
    await F.piStatus(db.app, a.id, a.piId, "succeeded", {}, 12);
    const h = harness(w, [8], { start: F.at(20) });
    await h.until(a.id, isEnd, { max: 5 });
    assert.equal(await reasonOf(a.id), "PROTECTED_RESERVATION_ID");
    assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED"), 0);
    assert.equal(w.count("CAPTURE"), 0);
  }
});

test("authorization deadline crossing at each await: before reads, during reads, between claim and send; after the send verified money is truth", async () => {
  const need = CAPTURE_DEFAULT_TIMEOUTS.captureCallMs + CAPTURE_LIMITS.sendMarginMs;
  let n = 0;
  const mk = async () => { n += 1; const w = world(); const a = await capIntent(w, 9, { from: addDays("2027-04-01", 6 * n), to: addDays("2027-04-01", 6 * n + 4) }); return { w, a }; };
  // (a) already too close before any read
  { const { w, a } = await mk(); const h = harness(w, [9], { start: a.intent.payment.authorizationDeadline - need });
    const r = await h.step({ intentId: a.id });
    assert.equal(await reasonOf(a.id), "AUTHORIZATION_DEADLINE_PASSED", JSON.stringify(r)); assert.deepEqual(w.calls, []); }
  // (b) crossed during the PI read (before the claim)
  { const { w, a } = await mk(); const h = harness(w, [9], { start: a.intent.payment.authorizationDeadline - need - 20 * 1000 });
    w.onPiRead = async () => { h.clk.t += 21 * 1000; };
    await h.step({ intentId: a.id });
    assert.equal(await reasonOf(a.id), "AUTHORIZATION_DEADLINE_PASSED"); assert.equal(w.count("CAPTURE"), 0);
    assert.equal((await opsOf(a.id, OPS.CAPTURE))[0].state, "pending"); }
  // (c) crossed during the reservation read
  { const { w, a } = await mk(); const h = harness(w, [9], { start: a.intent.payment.authorizationDeadline - need - 20 * 1000 });
    w.onResRead = async () => { h.clk.t += 21 * 1000; };
    await h.step({ intentId: a.id });
    assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required"); assert.equal(w.count("CAPTURE"), 0); }
  // (d) crossed between claim and send (leases extended so only the deadline fails)
  { const { w, a } = await mk(); const h = harness(w, [9], { start: a.intent.payment.authorizationDeadline - need - 20 * 1000 });
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => {
      h.clk.t += 21 * 1000; await setOpLease(op.id, h.clk.t + 10 * MIN); await setWorkLease(a.id, h.clk.t + 10 * MIN);
    } } });
    assert.ok(r.actions.includes("SEND_ABORTED:DEADLINE"), JSON.stringify(r.actions)); assert.equal(w.count("CAPTURE"), 0);
    assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown"); }
  // (e) crossed DURING the capture call: the confirmed captured money is recorded (deadline only blocks NEW sends)
  { const { w, a } = await mk(); const h = harness(w, [9], { start: a.intent.payment.authorizationDeadline - need - 1000 });
    w.onCapture = async () => { h.clk.t = a.intent.payment.authorizationDeadline + 30 * MIN; };
    await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => {
      await setOpLease(op.id, h.clk.t + 2 * 3600e3); await setWorkLease(a.id, h.clk.t + 2 * 3600e3);
    } } });
    assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured", "captured proof after the deadline is accepted as truth");
    assert.equal(w.count("CAPTURE"), 1); }
  // (f) captured at the provider, crash, reconciled long AFTER the deadline -> RECONCILED_CAPTURE_SUCCEEDED (no new send)
  { const { w, a } = await mk(); const h = harness(w, [9]);
    await assert.rejects(h.step({ intentId: a.id, hooks: { afterSend: async () => { throw new Error("crash"); } } }), /crash/);
    h.clk.t = a.intent.payment.authorizationDeadline + 3600e3;
    await h.until(a.id, isEnd, { max: 20 });
    assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
    assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
    assert.equal(w.count("CAPTURE"), 1); }
});

test("pre-send guards, each independently: op ownership, op lease room, work ownership, work lease room, step budget — no send; no event after a lost lease", async () => {
  let n = 0;
  const mk = async () => { n += 1; const w = world(); const a = await capIntent(w, 10, { from: addDays("2027-05-01", 6 * n), to: addDays("2027-05-01", 6 * n + 4) }); return { w, a, h: harness(w, [10]) }; };
  const need = CAPTURE_DEFAULT_TIMEOUTS.captureCallMs + CAPTURE_LIMITS.sendMarginMs;
  // op held by someone else
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => { await setOpLease(op.id, h.clk.t + 10 * MIN, "intruder"); } } });
    assert.ok(r.actions.includes("SEND_ABORTED:OPERATION_NOT_HELD"), JSON.stringify(r.actions));
    assert.ok(r.actions.some((x) => x.startsWith("LEASE_LOST")));
    assert.equal(w.count("CAPTURE"), 0); assert.equal(await events(a.id, "CAPTURE_OUTCOME_UNKNOWN"), 0, "no event after a lost op lease"); }
  // op lease without room for the whole call + margin
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => { await setOpLease(op.id, h.clk.t + need); } } });
    assert.ok(r.actions.includes("SEND_ABORTED:OPERATION_LEASE_TOO_SHORT"), JSON.stringify(r.actions));
    assert.equal(w.count("CAPTURE"), 0); assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown"); }
  // work lease taken over
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async () => { await setWorkLease(a.id, h.clk.t + 10 * MIN, "intruder"); } } });
    assert.ok(r.actions.includes("SEND_ABORTED:WORK_LEASE_NOT_HELD"), JSON.stringify(r.actions));
    assert.equal(w.count("CAPTURE"), 0);
    assert.equal((await opsOf(a.id, OPS.CAPTURE))[0].state, "outcome_unknown");
    assert.equal(await events(a.id, "CAPTURE_OUTCOME_UNKNOWN"), 0, "no event without the work lease");
    assert.equal((await loadIntent(db.app, a.id)).status, "reservation_confirmed");
    // the accepted planner later records the unknown, then reads (never a send)
    await setWorkLease(a.id, h.clk.t - 1, "intruder");
    await h.until(a.id, isEnd, { max: 25 });
    assert.equal(await reasonOf(a.id), "CAPTURE_STILL_AUTHORIZED_UNRESOLVED"); assert.equal(w.count("CAPTURE"), 0); }
  // work lease without room
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async (op) => { await setOpLease(op.id, h.clk.t + 10 * MIN); await setWorkLease(a.id, h.clk.t + need); } } });
    assert.ok(r.actions.includes("SEND_ABORTED:WORK_LEASE_TOO_SHORT"), JSON.stringify(r.actions)); assert.equal(w.count("CAPTURE"), 0); }
  // step budget does not cover the call
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, monotonic: () => h.clk.m, hooks: { afterClaim: async () => { h.clk.m += CAPTURE_DEFAULT_TIMEOUTS.stepBudgetMs - CAPTURE_DEFAULT_TIMEOUTS.captureCallMs; } } });
    assert.ok(r.actions.includes("SEND_ABORTED:STEP_BUDGET"), JSON.stringify(r.actions)); assert.equal(w.count("CAPTURE"), 0); }
  // intent changed after the claim (version bump) -> no send
  { const { w, a, h } = await mk();
    const r = await h.step({ intentId: a.id, hooks: { afterClaim: async () => { await db.owner.query("UPDATE booking.intents SET version = version + 1 WHERE id = $1", [a.id]); } } });
    assert.ok(r.actions.some((x) => x.startsWith("SEND_ABORTED:")), JSON.stringify(r.actions)); assert.equal(w.count("CAPTURE"), 0); }
});

test("crash windows: after claim, after send, after confirming evidence, after completion, before unknown settlement — exactly one capture, accepted planner recovery", async () => {
  const windows = [
    ["afterClaim", "ok", "reconciliation_required", 0], ["afterSend", "ok", "payment_captured", 1], ["afterConfirmEvidence", "ok", "payment_captured", 1],
    ["afterComplete", "ok", "payment_captured", 1], ["beforeSettleUnknown", "500", "reconciliation_required", 1], ["beforeSettleUnknown", "500Captured", "payment_captured", 1]
  ];
  let n = 0;
  for (const [hook, mode, end, sends] of windows) {
    n += 1;
    const w = world(); w.captureMode = mode;
    const a = await capIntent(w, 11, { from: addDays("2027-07-01", 6 * n), to: addDays("2027-07-01", 6 * n + 4) });
    const h = harness(w, [11]);
    await assert.rejects(h.step({ intentId: a.id, hooks: { [hook]: async () => { throw new Error("crash"); } } }), /crash/, hook);
    w.captureMode = "ok";
    assert.equal(await h.until(a.id, isEnd, { max: 30 }), end, `${hook}/${mode}`);
    await oneCaptureRow(w, a.id, sends);
    if (hook === "afterComplete") {
      // the planner records the unknown FIRST, then a fresh read reconciles
      assert.equal(await events(a.id, "CAPTURE_OUTCOME_UNKNOWN"), 1);
      assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
      assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 0);
    }
  }
});

test("two workers racing the same intent: one claim, one send", async () => {
  const w = world();
  const a = await capIntent(w, 12);
  const h = harness(w, [12]);
  const rs = await Promise.all([h.step({ intentId: a.id }), h.step({ intentId: a.id, workerId: "cw2" }), h.step({ workerId: "cw3" })]);
  assert.equal(rs.filter((r) => r.status === "worked").length, 1, "the work claim admits one worker");
  assert.equal(w.count("CAPTURE"), 1);
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  // explicit op-claim race: a second worker can never claim the same (now non-pending) row
  const b = await capIntent(w, 12, { from: "2027-01-02", to: "2027-01-06" });
  const c1 = await claimNextOperation(db.app, { workerId: "x1", now: F.at(10), opId: b.capOpId, opTypes: [OPS.CAPTURE] });
  const c2 = await claimNextOperation(db.app, { workerId: "x2", now: F.at(10), opId: b.capOpId, opTypes: [OPS.CAPTURE] });
  assert.ok(c1); assert.equal(c2, null);
});

test("a late capture callback racing the unknown settlement is only late evidence, recorded after the settlement commits; never an event", async () => {
  const w = world(); w.captureMode = "late";
  const a = await capIntent(w, 13);
  const h = harness(w, [13]);
  const r = await h.step({ intentId: a.id, timeouts: SHORT, hooks: { beforeSettleUnknown: async () => { w.releaseLate(); await new Promise((res) => setImmediate(res)); } } });
  await r.late;
  assert.equal(w.signals.at(-1).aborted, true, "the call was aborted at its timeout");
  const op = (await opsOf(a.id, OPS.CAPTURE))[0];
  assert.deepEqual([op.state, op.late_result_status, op.late_result_ref], ["outcome_unknown", "succeeded", `ch_test_${a.id.slice(0, 8)}`]);
  assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown");
  assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 0);
  await h.until(a.id, isEnd, { max: 20 });
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
  await oneCaptureRow(w, a.id, 1);
});

test("every provider hang is bounded (account, reservation, lookup, PI, capture, confirming read) and caller timeouts may only shorten", async () => {
  const kinds = ["account", "res", "lookup", "pi", "capture", "confirm"];
  let n = 0;
  for (const k of kinds) {
    n += 1;
    const w = world();
    const a = await capIntent(w, 14, { from: addDays("2027-08-01", 6 * n), to: addDays("2027-08-01", 6 * n + 4), noRef: k === "lookup" });
    if (k === "account") w.accountMode = "hang";
    if (k === "res") w.retrieveMode = "hang";
    if (k === "lookup") w.lookupMode = "hang";
    if (k === "pi") w.piMode = "hang";
    if (k === "capture") w.captureMode = "hang";
    if (k === "confirm") w.onCapture = async () => { w.piMode = "hang"; };
    const h = harness(w, [14]);
    const t0 = Date.now();
    const r = await h.step({ intentId: a.id, timeouts: SHORT });
    assert.ok(Date.now() - t0 < 3000, `${k} bounded`);
    if (k === "capture" || k === "confirm") assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown", k);
    else { assert.equal(w.count("CAPTURE"), 0, k); assert.ok(r.actions.some((x) => x.startsWith("WAIT:")), `${k} ${JSON.stringify(r.actions)}`); }
  }
  assert.deepEqual(_internal.resolveTimeouts({ readCallMs: 10 ** 9, captureCallMs: -1, stepBudgetMs: 5 }), { ...CAPTURE_DEFAULT_TIMEOUTS, stepBudgetMs: 5 });
});

test("capture_unknown with the authorization fully canceled -> RECONCILED_AUTHORIZATION_GONE, compensation only QUEUED (zero executed)", async () => {
  const w = world(); w.captureMode = "500";
  const a = await capIntent(w, 15);
  const h = harness(w, [15]);
  await h.step({ intentId: a.id });
  assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown");
  w.pis.get(a.piId).status = "canceled";
  await h.until(a.id, (st) => st !== "capture_unknown", { max: 20 });
  assert.equal(await events(a.id, "RECONCILED_AUTHORIZATION_GONE"), 1);
  const comp = (await db.app.query("SELECT op_type, state, dispatched_at FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('hostaway.cancel_reservation', 'stripe.void_payment_intent', 'stripe.refund')", [a.id])).rows;
  assert.ok(comp.length >= 1, "compensation queued");
  assert.ok(comp.every((o) => o.state === "pending" && o.dispatched_at === null), JSON.stringify(comp));
  // the worker never touches it (out of its states / op types)
  for (let k = 0; k < 3; k++) { h.clk.t += 10 * MIN; await h.step(); }
  assert.ok((await db.app.query("SELECT state FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('hostaway.cancel_reservation', 'stripe.void_payment_intent')", [a.id])).rows.every((o) => o.state === "pending"));
  await oneCaptureRow(w, a.id, 1);
});

test("out-of-scope rows are untouched (snapshots) and > 100 noise rows never starve the worker (unscoped steps)", async () => {
  const other = L(90);
  // 105 unknown capture rows on an UNCONFIGURED listing, all older (awaiting recovery)
  for (let k = 0; k < 105; k++) {
    const r = await F.reserved(db.app, { listingId: other, from: addDays("2028-01-01", 5 * k), to: addDays("2028-01-01", 5 * k + 4) });
    await F.runOp(db.app, r.id, OPS.CAPTURE, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  }
  // 105 orphan PI reads on an unconfigured listing
  const host = await F.reserved(db.app, { listingId: other, from: "2030-06-01", to: "2030-06-05" });
  for (let k = 0; k < 105; k++) {
    const id = await requestRead(db.app, host.id, OPS.PI_READ, `pi_test_noise_${k}`, { now: F.at(8) });
    const c = await claimNextOperation(db.app, { workerId: "noise", now: F.at(8), opId: id });
    F.ok(await completeOperation(db.app, c.id, { workerId: "noise", now: F.at(8), outcome: { status: "succeeded" } }));
  }
  // out-of-scope rows on the CONFIGURED listing: captured (offline charge pending + an expired in-flight PI read), capture_failed
  // (void pending), reservation-phase dispatch, and payment rows of a payment_authorized intent
  const cfgL = L(91);
  const capd = await F.captured(db.app, { listingId: cfgL, from: "2027-09-01", to: "2027-09-05" });
  const rd = await requestRead(db.app, capd.id, OPS.PI_READ, capd.piId, { now: F.at(9) });
  await claimNextOperation(db.app, { workerId: "x", now: F.at(9), opId: rd });
  const orphan = await requestRead(db.app, capd.id, OPS.RES_READ, String(capd.reservationId), { now: F.at(9) });
  const oc = await claimNextOperation(db.app, { workerId: "x", now: F.at(9), opId: orphan });
  F.ok(await completeOperation(db.app, oc.id, { workerId: "x", now: F.at(9), outcome: { status: "succeeded" } }));   // orphan: no evidence
  const fl = await F.reserved(db.app, { listingId: cfgL, from: "2027-10-01", to: "2027-10-05" });
  await F.runOp(db.app, fl.id, OPS.CAPTURE, 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, fl.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  const pend = await F.dispatched(db.app, { listingId: cfgL, from: "2027-11-01", to: "2027-11-05" });
  const auth = await F.authorized(db.app, { listingId: cfgL, from: "2027-12-01", to: "2027-12-05" });
  const outIds = [capd.id, fl.id, pend.id, auth.id];
  const snap = async () => ({
    ops: (await db.app.query("SELECT id, state, error_code, lease_worker_id, updated_at FROM booking.external_operations WHERE intent_id = ANY($1) OR intent_id IN (SELECT id FROM booking.intents WHERE listing_id = $2) ORDER BY id", [outIds, other])).rows,
    intents: (await db.app.query("SELECT id, state, version FROM booking.intents WHERE id = ANY($1) OR listing_id = $2 ORDER BY id", [outIds, other])).rows,
    work: (await db.app.query("SELECT intent_id, work_worker_id, next_action_at FROM booking.intent_work WHERE intent_id = ANY($1) ORDER BY intent_id", [outIds])).rows
  });
  const before0 = await snap();
  // targets: a fresh initial capture and an earlier crash (completed, event lost) — UNSCOPED steps far in the future
  const w = world();
  const t1 = await capIntent(w, 91, { from: "2028-12-01", to: "2028-12-05" });
  const t2 = await capIntent(w, 91, { from: "2029-01-01", to: "2029-01-05" });
  const h = harness(w, [91], { start: F.at(600) });
  await assert.rejects(h.step({ intentId: t2.id, hooks: { afterComplete: async () => { throw new Error("crash"); } } }), /crash/);
  for (let k = 0; k < 40 && !((await loadIntent(db.app, t1.id)).status === "payment_captured" && (await loadIntent(db.app, t2.id)).status === "payment_captured"); k++) {
    h.clk.t += MIN; const r = await h.step(); await settleLate(r);
  }
  assert.equal((await loadIntent(db.app, t1.id)).status, "payment_captured");
  assert.equal((await loadIntent(db.app, t2.id)).status, "payment_captured");
  assert.deepEqual(await snap(), before0, "no out-of-scope row was touched");
  assert.equal(w.count("CAPTURE"), 2);
});

test("durable exhaustion: failing PI reads become an owner case (not silent rescheduling); orphan re-issue exhaustion escalates in scope", async () => {
  const w = world(); w.piMode = "500";
  const a = await capIntent(w, 16);
  const h = harness(w, [16]);
  await h.until(a.id, isEnd, { max: 80, advanceMs: 10 * MIN });
  assert.equal(await reasonOf(a.id), "PRE_CAPTURE_READS_EXHAUSTED");
  assert.equal(w.count("CAPTURE"), 0);
  assert.ok(w.count("PI ") <= CAPTURE_LIMITS.maxPreCaptureReadsPerType, `bounded ${w.count("PI ")}`);
  // capture_unknown: failing reads exhaust the bounded recovery reads -> durable owner case (never a send)
  const w2 = world(); w2.captureMode = "500";
  const b = await capIntent(w2, 16, { from: "2027-01-05", to: "2027-01-09" });
  const h2 = harness(w2, [16]);
  await h2.step({ intentId: b.id });
  w2.piMode = "500";
  await h2.until(b.id, isEnd, { max: 120, advanceMs: 10 * MIN });
  assert.match(await reasonOf(b.id), /EXHAUSTED/);
  await oneCaptureRow(w2, b.id, 1);
  // an orphan read (succeeded, evidence never recorded: crash) is re-issued (scoped) and its re-issue is then used
  const w3 = world();
  const c = await capIntent(w3, 16, { from: "2027-01-15", to: "2027-01-19" });
  const h3 = harness(w3, [16]);
  const rd = await requestRead(db.app, c.id, OPS.RES_READ, String(c.reservationId), { now: h3.clk.t });
  const cl = await claimNextOperation(db.app, { workerId: "w-crash", now: h3.clk.t, opId: rd });
  F.ok(await completeOperation(db.app, cl.id, { workerId: "w-crash", now: h3.clk.t, outcome: { status: "succeeded" } }));
  h3.clk.t += 3 * MIN;
  const r = await h3.step();
  assert.ok(r.actions.includes("RECOVERY:REISSUE"), JSON.stringify(r.actions));
  assert.equal((await loadIntent(db.app, c.id)).status, "payment_captured");
  const reads = await opsOf(c.id, OPS.RES_READ);
  assert.equal(reads.length, 2);
  assert.equal(reads[1].payload.reissueOf, rd, "the re-issued read (not a new one) proved the reservation");
  // re-issued reads that are themselves orphaned: at most MAX depth, then a durable in-scope owner case (the intent's work
  // is held elsewhere meanwhile, so only the recovery pass runs)
  const w4 = world();
  const d = await capIntent(w4, 16, { from: "2027-01-25", to: "2027-01-29" });
  const h4 = harness(w4, [16]);
  let readId = await requestRead(db.app, d.id, OPS.RES_READ, String(d.reservationId), { now: h4.clk.t });
  for (let depth = 0; depth < 6 && (await loadIntent(db.app, d.id)).status === "reservation_confirmed"; depth++) {
    const x = await claimNextOperation(db.app, { workerId: "w-crash", now: h4.clk.t, opId: readId });
    F.ok(await completeOperation(db.app, x.id, { workerId: "w-crash", now: h4.clk.t, outcome: { status: "succeeded" } }));
    h4.clk.t += 3 * MIN;
    await setWorkLease(d.id, h4.clk.t + 10 * MIN, "intruder");
    await h4.step();
    readId = (await db.app.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending'", [d.id, OPS.RES_READ])).rows[0]?.id;
  }
  assert.equal((await loadIntent(db.app, d.id)).status, "reconciliation_required");
  assert.equal(await reasonOf(d.id), "READ_REISSUE_EXHAUSTED");
  assert.equal(w4.count("CAPTURE"), 0);
});

test("capture_unknown with an unproven provider status (processing) -> bounded inconclusive -> owner case; no cancel / void / new capture", async () => {
  const w = world(); w.captureMode = "500";
  const a = await capIntent(w, 17);
  const h = harness(w, [17]);
  await h.step({ intentId: a.id });
  w.pis.get(a.piId).status = "processing";
  await h.until(a.id, isEnd, { max: 60, advanceMs: 5 * MIN });
  assert.equal((await loadIntent(db.app, a.id)).status, "reconciliation_required");
  assert.equal(await events(a.id, "RECONCILED_CAPTURE_SUCCEEDED") + await events(a.id, "RECONCILED_AUTHORIZATION_GONE") + await events(a.id, "RECONCILED_STILL_AUTHORIZED"), 0);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('stripe.void_payment_intent', 'hostaway.cancel_reservation')", [a.id]), 0);
  await oneCaptureRow(w, a.id, 1);
});

test("explicit non-success capture reply contract: a reply whose status is not 'succeeded' is unknown at once — no confirming read, no event", async () => {
  const w = world(); w.captureMode = "replyNotSucceeded";
  const a = await capIntent(w, 18);
  const h = harness(w, [18]);
  const r = await h.step({ intentId: a.id });
  assert.ok(r.actions.includes("CAPTURE_OUTCOME_UNKNOWN:CAPTURE_REPLY_NOT_SUCCESS"), JSON.stringify(r.actions));
  assert.equal(w.count("PI "), 1, "only the pre-send read; no confirming read for a non-success reply");
  assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 0);
  assert.equal((await loadIntent(db.app, a.id)).status, "capture_unknown");
});

test("success-event fences: a concurrent webhook outcome between completion and the worker event wins; the worker never double-applies", async () => {
  const w = world();
  const a = await capIntent(w, 19);
  const h = harness(w, [19]);
  const r = await h.step({ intentId: a.id, hooks: { afterComplete: async () => {
    F.ok(await applyEvent(db.app, a.id, { type: "CAPTURE_SUCCEEDED", id: "evt_webhook_capture", amountMinor: 576000, currency: "mxn" }, { now: h.clk.t, actor: "webhook" }));
  } } });
  // E3 recognises the same-money capture as a duplicate before any fence runs: a no-op with no effects
  assert.ok(r.actions.includes("CAPTURE_SUCCEEDED:DUPLICATE"), JSON.stringify(r.actions));
  assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 1);
  assert.equal((await opsOf(a.id, "hostaway.record_offline_charge")).length, 1, "one offline charge queued");
});

test("success-event fences (CONTRIVED invariant, owner-tampered disposable fixture): changed op result / intent version between completion and event -> refused", async () => {
  // Not a realistic race: a succeeded capture row and an intent version cannot change without an event in production paths.
  // The owner role edits a throwaway fixture to show the in-transaction fences themselves hold (no trigger is disabled).
  for (const [name, tamper] of [
    ["opResult", (a, op) => db.owner.query("UPDATE booking.external_operations SET result_ref = 'ch_test_other' WHERE id = $1", [op.id])],
    ["intentVersion", (a) => db.owner.query("UPDATE booking.intents SET version = version + 1 WHERE id = $1", [a.id])]
  ]) {
    const w = world();
    const a = await capIntent(w, 20, { from: name === "opResult" ? "2027-01-02" : "2027-02-02", to: name === "opResult" ? "2027-01-06" : "2027-02-06" });
    const h = harness(w, [20]);
    let ok = true;
    const r = await h.step({ intentId: a.id, hooks: { afterComplete: async (op) => { try { await tamper(a, op); } catch { ok = false; } } } });
    if (!ok) { assert.ok(true, `${name}: database refused the owner edit itself`); continue; }
    assert.ok(r.actions.includes("CAPTURE_SUCCEEDED!STALE_CAPTURE_EVENT"), `${name} ${JSON.stringify(r.actions)}`);
    assert.equal(await events(a.id, "CAPTURE_SUCCEEDED"), 0, name);
    assert.notEqual((await loadIntent(db.app, a.id)).status, "payment_captured", name);
  }
});

// ---------------------------------------------------------------------------------------------
// root HOLD on 479022a: cross-phase races (another actor moves the intent out of the capture phase meanwhile)

const caseCount = (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1", [id]);
/** Another actor completes the capture with a valid same-money event (e.g. the Stripe webhook path). */
const webhookCaptured = (a, w, now) => {
  const p = w.pis.get(a.piId); p.status = "succeeded"; p.received = 576000;
  return applyEvent(db.app, a.id, { type: "CAPTURE_SUCCEEDED", id: `evt_webhook_${a.piId}`, amountMinor: 576000, currency: "mxn" }, { now, actor: "webhook" });
};

test("race (1): another actor captures during the pre-capture PI / reservation read -> the stale worker does nothing (no escalation of the paid intent)", async () => {
  for (const at of ["pi", "res"]) {
    const w = world();
    const a = await capIntent(w, 21, { from: at === "pi" ? "2027-01-02" : "2027-02-02", to: at === "pi" ? "2027-01-06" : "2027-02-06" });
    const h = harness(w, [21]);
    const cases0 = await caseCount(a.id);
    let done = false;
    const hook = async () => { if (!done) { done = true; F.ok(await webhookCaptured(a, w, h.clk.t)); } };
    if (at === "pi") w.onPiRead = hook; else w.onResRead = hook;
    const r = await h.step({ intentId: a.id });
    assert.ok(r.actions.some((x) => x === "ESCALATE!STALE_OUT_OF_SCOPE"), `${at} ${JSON.stringify(r.actions)}`);
    assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured", at);
    assert.equal((await opsOf(a.id, "hostaway.record_offline_charge")).length, 1, `${at}: one offline charge`);
    assert.equal(w.count("CAPTURE"), 0, `${at}: zero captures from the stale worker`);
    assert.equal(await events(a.id, "ESCALATE"), 0, at);
    assert.equal(await caseCount(a.id), cases0, `${at}: no extra case`);
    // later steps leave the paid intent alone
    for (let k = 0; k < 3; k++) { h.clk.t += 5 * MIN; await h.step(); }
    assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured", at);
  }
});

test("race (2): another reconciler settles capture_unknown between the worker's facts/decision and its still-authorized escalation -> fenced, no escalation", async () => {
  const w = world(); w.captureMode = "500";
  const a = await capIntent(w, 22);
  const h = harness(w, [22]);
  await h.step({ intentId: a.id });                       // unknown, original NOT captured; reads show still authorized
  let raced = false;
  const beforeRecoveryEscalate = async (facts, code) => {
    if (raced || code !== "CAPTURE_STILL_AUTHORIZED_UNRESOLVED") return;
    raced = true;
    // the provider now shows the original capture (it completed late); another reconciler records and applies it
    const p = w.pis.get(a.piId); p.status = "succeeded"; p.received = 576000;
    await F.piStatus(db.app, a.id, a.piId, "succeeded", paymentIntentProofObservationV3(w.piObj(p), { accountVerified: true }), (h.clk.t - F.T0) / MIN);
    const f2 = await loadRecoveryFacts(db.app, facts.op.id);
    const plan = planRecovery({ ...f2, now: h.clk.t });
    assert.equal(plan.event && plan.event.type, "RECONCILED_CAPTURE_SUCCEEDED");
    F.ok(await applyRecoveryPlan(db.app, plan, { now: h.clk.t }));
  };
  const seen = [];
  for (let k = 0; k < 20 && !raced; k++) { h.clk.t += MIN; const r = await h.step({ intentId: a.id, hooks: { beforeRecoveryEscalate } }); seen.push(...r.actions); }
  assert.ok(raced, "the still-authorized escalation decision was reached");
  assert.ok(seen.some((x) => x === "RECOVERY:ESCALATE!STALE_OUT_OF_SCOPE" || x === "RECOVERY:ESCALATE:DUPLICATE_EVENT_ID"), JSON.stringify(seen));
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  assert.equal(await events(a.id, "ESCALATE"), 0);
  assert.equal(await events(a.id, "RECONCILED_STILL_AUTHORIZED"), 0);
  await oneCaptureRow(w, a.id, 1);
});

test("race (2b): another reconciler bumps capture_unknown (same state, new version) between the decision and the escalation -> fence refuses; re-decided on fresh facts", async () => {
  // A distinct event id (op-inconclusive:*) keeps the state but advances the version: only the version/state fence (not
  // event-id de-duplication or E3 route legality) can stop the stale decision here.
  const w = world(); w.captureMode = "500";
  const a = await capIntent(w, 23);
  const h = harness(w, [23]);
  await h.step({ intentId: a.id });
  let raced = false; let staleVersion = null;
  const beforeRecoveryEscalate = async (facts, code) => {
    if (raced || code !== "CAPTURE_STILL_AUTHORIZED_UNRESOLVED") return;
    raced = true; staleVersion = facts.intent.version;
    F.ok(await applyEvent(db.app, a.id, { type: "RECONCILIATION_INCONCLUSIVE", id: `op-inconclusive:${facts.op.id}:other`, code: "OTHER_RECONCILER", subject: "payment" },
      { now: h.clk.t, actor: "reconciler" }));
  };
  const seen = [];
  for (let k = 0; k < 20 && !raced; k++) { h.clk.t += MIN; const r = await h.step({ intentId: a.id, hooks: { beforeRecoveryEscalate } }); seen.push(...r.actions); }
  assert.ok(raced);
  assert.ok(seen.includes("RECOVERY:ESCALATE!STALE_OUT_OF_SCOPE"), JSON.stringify(seen));
  const mid = await loadIntent(db.app, a.id);
  assert.equal(mid.status, "capture_unknown", "the stale decision escalated nothing");
  assert.equal(await events(a.id, "ESCALATE"), 0);
  assert.ok(mid.version > staleVersion);
  // later, re-decided on FRESH facts: still authorized -> owner case (once), never a send
  await h.until(a.id, isEnd, { max: 30, extra: { hooks: { beforeRecoveryEscalate } } });
  assert.equal(await reasonOf(a.id), "CAPTURE_STILL_AUTHORIZED_UNRESOLVED");
  assert.equal(await events(a.id, "ESCALATE"), 1);
  await oneCaptureRow(w, a.id, 1);
});

test("race (3): the intent leaves the capture phase after the work claim and before maintenance -> its expired PI read row is untouched", async () => {
  const w = world();
  const a = await capIntent(w, 24);
  const h = harness(w, [24]);
  const rd = await requestRead(db.app, a.id, OPS.PI_READ, a.piId, { now: h.clk.t - 5 * MIN });
  await claimNextOperation(db.app, { workerId: "x-old", now: h.clk.t - 5 * MIN, opId: rd });          // lease expired at -4 min
  const before = (await db.app.query("SELECT state, lease_worker_id, updated_at, error_code FROM booking.external_operations WHERE id = $1", [rd])).rows[0];
  await h.step({ intentId: a.id, hooks: { beforeMaintenance: async () => { F.ok(await webhookCaptured(a, w, h.clk.t)); } } });
  const after = (await db.app.query("SELECT state, lease_worker_id, updated_at, error_code FROM booking.external_operations WHERE id = $1", [rd])).rows[0];
  assert.deepEqual(after, before, "out-of-phase row unchanged");
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  assert.equal(w.count("CAPTURE"), 0);
  // positive control: the same situation WITHOUT the transition is recovered by this worker
  const b = await capIntent(w, 24, { from: "2027-01-02", to: "2027-01-06" });
  const rb = await requestRead(db.app, b.id, OPS.PI_READ, b.piId, { now: h.clk.t - 5 * MIN });
  await claimNextOperation(db.app, { workerId: "x-old", now: h.clk.t - 5 * MIN, opId: rb });
  await h.step({ intentId: b.id, hooks: { beforeMaintenance: async () => {} } });
  assert.notEqual((await db.app.query("SELECT state FROM booking.external_operations WHERE id = $1", [rb])).rows[0].state, "in_flight");
});

test("(4) pre-send uses CURRENT rows: a stale/cached plan (changed proof snapshot, reservation binding or request) is refused; the real plan sends", async () => {
  // Focused guard test with an injected stale PLAN (no owner edits): DB invariants (0001 booking.intents guard) already forbid
  // changing price, stay, PaymentIntent and reservation id, so a mismatch can only come from a stale in-memory plan.
  const w = world();
  const a = await capIntent(w, 25);
  const h = harness(w, [25]);
  const got = {};
  await h.step({ intentId: a.id, hooks: { afterClaim: async (op, plan) => {
    const ctx = { pool: db.app, workerId: "cw1", clock: () => h.clk.t, timeouts: CAPTURE_DEFAULT_TIMEOUTS, stepEndsAt: Number.POSITIVE_INFINITY, mono: () => 0 };
    const elig = (snap) => ({ ...plan.eligibility, snapshot: { ...plan.eligibility.snapshot, ...snap } });
    got.real = await _internal.preSendCapture(ctx, a.id, op.id, plan);
    got.price = await _internal.preSendCapture(ctx, a.id, op.id, { ...plan, eligibility: elig({ priceMinor: 576001 }) });
    got.deadline = await _internal.preSendCapture(ctx, a.id, op.id, { ...plan, eligibility: elig({ authorizationDeadline: plan.eligibility.snapshot.authorizationDeadline + 1 }) });
    got.key = await _internal.preSendCapture(ctx, a.id, op.id, { ...plan, eligibility: elig({ idempotencyKey: "cap:other" }) });
    got.res = await _internal.preSendCapture(ctx, a.id, op.id, { ...plan, reservation: { ...plan.reservation, reservationId: "1" } });
    got.req = await _internal.preSendCapture(ctx, a.id, op.id, { ...plan, request: { ...plan.request, params: { ...plan.request.params, amount_to_capture: 100 } } });
  } } });
  assert.deepEqual(got, { real: null, price: "PROOF_SNAPSHOT_CHANGED", deadline: "PROOF_SNAPSHOT_CHANGED", key: "PROOF_SNAPSHOT_CHANGED",
    res: "RESERVATION_BINDING_CHANGED", req: "REQUEST_INVALID_FOR_CURRENT" });
  assert.equal((await loadIntent(db.app, a.id)).status, "payment_captured");
  assert.equal(w.count("CAPTURE"), 1);
});
