// E7 operator TEST abort — throwaway local PostgreSQL (migrations 0001–0016), runtime code as mv_booking_app; FAKE Stripe + Hostaway
// executors for the accepted compensation worker (no network, no SDK, no credentials). db.owner is used ONLY to plant hostile state.
// Every id / amount / guest below is synthetic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { runCleanupStep, OPS } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { requestTestAbort, TEST_ABORT_CODES } from "../../lib/booking-db/test-abort.js";
import { buildAbortExpectation, classify, executeOperatorAbort } from "../../scripts/e7-operator/test-abort.mjs";
import { TEST_ABORT_REASON } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const LISTING = 606998;
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" });
const CLEAN_ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const ACCT = "acct_1TestAbortWorker";
const REF_FIELD = 777011;
const TZ = "America/Mazatlan";
const MIN = F.MIN;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let stayN = 0;
const nextStay = () => { stayN += 1; return { listingId: LISTING, currency: "USD", from: addDays("2027-02-01", 5 * stayN), to: addDays("2027-02-01", 5 * stayN + 3) }; };
const hex8 = () => randomUUID().replace(/-/g, "").slice(0, 12);

/** a reservation_confirmed TEST intent on 606998 / USD with ONE pending, never-dispatched capture row (accepted E3 transitions only) */
async function confirmedIntent() {
  const stay = nextStay();
  const p = await F.pending(db.app, stay);
  const piId = `pi_ABRT${hex8()}`;
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  const rid = F.nextReservationId() + 61000000;
  const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(7), actor: "worker" }));
  const i = await loadIntent(db.app, p.id);
  assert.equal(i.status, "reservation_confirmed");
  const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [p.id])).rows[0].id;
  const e = buildAbortExpectation({ intentId: p.id, expectedVersion: i.version, listingId: LISTING, from: stay.from, to: stay.to, guests: i.guests, currency: "USD",
    finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: piId, sessionId: p.sessionId, attemptId: pa,
    reservationId: String(rid), approvalRef: "synthetic-abort-pg" });
  assert.ok(e, "expectation builds");
  return { id: p.id, piId, rid: String(rid), stay, e, intent: i, ref: i.ref, paymentAttemptId: pa };
}
const opsOf = async (id, t = null) => (await db.app.query(`SELECT id, op_type, state, attempts, dispatched_at, lease_worker_id FROM booking.external_operations
  WHERE intent_id = $1 ${t ? "AND op_type = $2" : ""} ORDER BY created_at, id`, t ? [id, t] : [id])).rows;
const snap = async (id) => ({
  version: (await db.app.query("SELECT version, state FROM booking.intents WHERE id = $1", [id])).rows[0],
  transitions: await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [id]),
  applied: await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_applied_events WHERE intent_id = $1", [id]),
  ops: (await opsOf(id)).map((o) => `${o.op_type}:${o.state}:${o.attempts}:${o.dispatched_at === null}`),
  claimReleased: (await db.app.query("SELECT released_at IS NOT NULL AS r FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows.map((r) => r.r)
});
const state = async (id) => (await loadIntent(db.app, id)).status;
const legs = async (id) => { const r = (await db.app.query("SELECT settlement_reservation_cancelled AS c, settlement_authorization_settled AS a FROM booking.intents WHERE id = $1", [id])).rows[0]; return [r.c, r.a]; };
const claimHeld = async (id) => (await db.app.query("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).rows[0].n === 1;
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

test("D1 abort: ONE E3 event (admin) → capture_failed / TEST_ABORT_REQUESTED; exactly one pending cancel + void + alert; capture row kept pending; claim held; replay duplicate", async () => {
  const a = await confirmedIntent();
  const s0 = await snap(a.id);
  assert.deepEqual(await classify(db.app, a.e).then((c) => c.class), "ELIGIBLE");
  const r = await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e });
  assert.equal(r.ok, true, r.error);
  const i = await loadIntent(db.app, a.id);
  assert.deepEqual([i.status, i.reasonCode, i.version], ["capture_failed", TEST_ABORT_REASON, s0.version.version + 1]);
  const tr = (await db.app.query("SELECT from_state, to_state, event_type, actor FROM booking.intent_transitions WHERE intent_id = $1 ORDER BY version_after DESC LIMIT 1", [a.id])).rows[0];
  assert.deepEqual(tr, { from_state: "reservation_confirmed", to_state: "capture_failed", event_type: "TEST_ABORT_REQUESTED", actor: "admin" });
  const after1 = await snap(a.id);
  const added = after1.ops.filter((x) => !s0.ops.includes(x) || after1.ops.filter((y) => y === x).length > s0.ops.filter((y) => y === x).length);
  assert.deepEqual(added.sort(), ["alert.owner:pending:0:true", "hostaway.cancel_reservation:pending:0:true", "stripe.void_payment_intent:pending:0:true"]);
  const cap = await opsOf(a.id, OPS.CAPTURE);
  assert.equal(cap.length, 1);
  assert.deepEqual([cap[0].state, cap[0].attempts, cap[0].dispatched_at], ["pending", 0, null], "capture row kept as audit, untouched");
  assert.deepEqual(after1.claimReleased, [false]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'CAPTURE_FAILED'", [a.id])).rows[0].n, 0, "no CAPTURE_FAILED fabricated");
  // replay: duplicate, nothing new
  const again = await requestTestAbort(db.app, a.id, { now: F.at(10), env: ENV, operator: a.e });
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  assert.deepEqual(await snap(a.id), after1);
  const c = await classify(db.app, a.e);
  assert.deepEqual([c.class, c.state, c.cancelState, c.voidState, c.captureState, c.captureDispatched, c.claimReleased, c.reason],
    ["ALREADY_REQUESTED", "capture_failed", "pending", "pending", "pending", false, false, TEST_ABORT_REASON]);
  assert.equal(JSON.stringify(c).includes(a.ref), false, "no booking ref / guest data in the projection");
  // the operator core: exactly ONE call, then read-only reconciliation; a second execute makes zero calls
  const b = await confirmedIntent();
  let calls = 0;
  const x = await executeOperatorAbort(db.app, b.e, { now: F.at(9), env: ENV, deps: { requestTestAbort: async (...args) => { calls += 1; return requestTestAbort(...args); } } });
  assert.deepEqual([x.outcome, x.invocations, calls, x.reconciled.class], ["REQUESTED", 1, 1, "ALREADY_REQUESTED"]);
  const y = await executeOperatorAbort(db.app, b.e, { now: F.at(10), env: ENV, deps: { requestTestAbort: async () => { calls += 1; throw new Error("never"); } } });
  assert.deepEqual([y.outcome, y.invocations, calls], ["NOT_EXECUTED_ALREADY_REQUESTED", 0, 1]);
  // a lost reply after commit is REQUEST_OUTCOME_UNKNOWN, reconciled read-only as ALREADY_REQUESTED; never re-sent
  const d = await confirmedIntent();
  const z = await executeOperatorAbort(db.app, d.e, { now: F.at(9), env: ENV, deps: { afterReply: async () => { throw new Error("lost reply"); } } });
  assert.deepEqual([z.outcome, z.invocations, z.reconciled.class], ["REQUEST_OUTCOME_UNKNOWN", 1, "ALREADY_REQUESTED"]);
});

test("D2 after the abort the pending capture row is unclaimable by every claim path (0007 + claim fence); the accepted capture-fence error names the fence", async () => {
  const a = await confirmedIntent();
  F.ok(await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e }));
  assert.equal(await claimNextOperation(db.app, { workerId: "cap", now: F.at(10), opTypes: [OPS.CAPTURE], intentId: a.id }), null);
  assert.equal(await claimNextOperation(db.app, { workerId: "any", now: F.at(10), intentId: a.id, opTypes: [OPS.CAPTURE] }), null);
  const capId = (await opsOf(a.id, OPS.CAPTURE))[0].id;
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = attempts + 1, dispatched_at = now() WHERE id = $1", [capId]),
    /CAPTURE_CLAIM_FENCED/);
  assert.deepEqual((await opsOf(a.id, OPS.CAPTURE)).map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]]);
});

test("D3 refusals are code-only with ZERO writes: gate, expectation, listing, protected id, stale, identity, lease, capture claimed / sent, history, evidence, open case", async () => {
  const a = await confirmedIntent();
  const s0 = await snap(a.id);
  const call = (o = {}) => requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e, ...o });
  const expect = async (r, code) => { assert.deepEqual([r.ok, r.error], [false, code]); assert.deepEqual(await snap(a.id), s0, code); };
  await expect(await call({ env: {} }), "TEST_ABORT_GATE_CLOSED");
  await expect(await call({ env: { VERCEL_ENV: "production", MV_E7_TEST_ABORT: "enabled" } }), "TEST_ABORT_GATE_CLOSED");
  await expect(await call({ env: { VERCEL_ENV: "preview" } }), "TEST_ABORT_GATE_CLOSED");
  await expect(await call({ operator: { ...a.e, extra: 1 } }), "TEST_ABORT_EXPECTATION_INVALID");
  await expect(await call({ operator: undefined }), "TEST_ABORT_EXPECTATION_INVALID");
  await expect(await requestTestAbort(db.app, randomUUID(), { now: F.at(9), env: ENV, operator: a.e }), "TEST_ABORT_EXPECTATION_INVALID");
  const rebuild = (o) => buildAbortExpectation((({ planHash, ...f }) => ({ ...f, ...o }))(a.e));   // eslint-disable-line no-unused-vars
  await expect(await call({ operator: { ...rebuild({}), listingId: 603566, planHash: a.e.planHash } }), "TEST_ABORT_LISTING_NOT_ALLOWED");
  await expect(await call({ operator: rebuild({ reservationId: "71081885" }) }), "TEST_ABORT_RESERVATION_PROTECTED");
  await expect(await call({ operator: rebuild({ expectedVersion: a.e.expectedVersion - 1 }) }), "TEST_ABORT_STALE");
  for (const o of [{ from: addDays(a.stay.from, 1) }, { guests: a.e.guests + 1 }, { finalTotalMinor: 1, authorizedMinor: 1 }, { sessionId: "cs_test_OTHERsess01" },
    { attemptId: randomUUID() }]) await expect(await call({ operator: rebuild(o) }), o.attemptId ? "TEST_ABORT_ATTEMPT_NOT_BOUND" : "TEST_ABORT_IDENTITY_MISMATCH");
  // PI / reservation mismatches are refused by the E3 reducer itself (the event binds both), before the transaction
  await expect(await call({ operator: rebuild({ paymentIntentId: "pi_ABRTnotThisOne" }) }), "TEST_ABORT_PAYMENT_MISMATCH");
  await expect(await call({ operator: rebuild({ reservationId: "61999999" }) }), "TEST_ABORT_RESERVATION_MISMATCH");
  // planted work lease (live or stale)
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'other', work_lease_until = now() - interval '1 hour' WHERE intent_id = $1", [a.id]);
  await expect(await call(), "TEST_ABORT_WORK_LEASE_HELD");
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [a.id]);
  // conflicting late evidence: the PaymentIntent observed as captured / canceled
  for (const st of ["succeeded", "canceled"]) {
    const evId = randomUUID();
    await db.owner.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, attested_by, reference, recorded_by_role, recorded_session_user, created_at)
      VALUES ($1, $2, 'payment_intent', 'stripe_dashboard', $3, $4, '{}'::jsonb, now(), 'test-owner', 'synthetic conflicting evidence', 'test', 'test', now())`, [evId, a.id, a.piId, st]);
    await expect(await call(), "TEST_ABORT_EVIDENCE_CONFLICT");
    await db.owner.query("ALTER TABLE booking.provider_evidence DISABLE TRIGGER USER");
    await db.owner.query("DELETE FROM booking.provider_evidence WHERE id = $1", [evId]);
    await db.owner.query("ALTER TABLE booking.provider_evidence ENABLE TRIGGER USER");
  }
  // an open reconciliation case on the intent
  const caseId = randomUUID();
  await db.owner.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
    VALUES ($1, $2, 'SYNTHETIC_CASE', 'open', now(), 'test', '{}'::jsonb)`, [caseId, a.id]);
  await expect(await call(), "TEST_ABORT_OPEN_CASE");
  await db.owner.query("ALTER TABLE booking.reconciliation_cases DISABLE TRIGGER USER");
  await db.owner.query("DELETE FROM booking.reconciliation_cases WHERE id = $1", [caseId]);
  await db.owner.query("ALTER TABLE booking.reconciliation_cases ENABLE TRIGGER USER");
  // the capture CLAIMED (possibly sent) — committed, never completed: refused, capturedMinor 0 proves nothing
  const op = await claimNextOperation(db.app, { workerId: "cap", now: F.at(9), opTypes: [OPS.CAPTURE], intentId: a.id });
  assert.ok(op && op.op_type === OPS.CAPTURE);
  const s1 = await snap(a.id);
  const r = await call();
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_CAPTURE_NOT_PRISTINE"]);
  assert.deepEqual(await snap(a.id), s1, "zero new effects after a committed capture claim");
  assert.ok(TEST_ABORT_CODES.length > 10);
  // a captured booking / an unknown capture is never abortable (state refusal through the reducer)
  const b = await confirmedIntent();
  F.ok(await applyEvent(db.app, b.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(9), actor: "worker" }));
  const rb = await requestTestAbort(db.app, b.id, { now: F.at(10), env: ENV, operator: b.e });
  assert.equal(rb.ok, false);
  assert.equal(await state(b.id), "capture_unknown");
});

test("D4 concurrency on real PG, both orders (overlap PROVEN by an observed lock wait): abort first → capture never claimable; capture claim first → abort refuses, zero effects", async () => {
  // (a) the abort holds the intent row (uncommitted); the capture claim BLOCKS on the intent share lock, then is refused by the fence
  const a = await confirmedIntent();
  let claimP = null;
  const r = await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e, hooks: { beforeCommit: async () => {
    claimP = claimNextOperation(db.app, { workerId: "racer", now: F.at(9), opTypes: [OPS.CAPTURE], intentId: a.id });
    await waitForLockWaiters(1);
  } } });
  assert.equal(r.ok, true, r.error);
  assert.equal(await claimP, null, "re-checked after the intent lock: the capture is fenced");
  assert.deepEqual((await opsOf(a.id, OPS.CAPTURE)).map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]]);
  // (b) the capture claim share-locks the intent first and holds it (uncommitted); the abort BLOCKS, the claim commits, the abort refuses
  const b = await confirmedIntent();
  const s0 = await snap(b.id);
  let abortP = null;
  const op = await claimNextOperation(db.app, { workerId: "racer", now: F.at(9), opTypes: [OPS.CAPTURE], intentId: b.id, hooks: { afterIntentLock: async () => {
    abortP = requestTestAbort(db.app, b.id, { now: F.at(9), env: ENV, operator: b.e });
    await waitForLockWaiters(1);
  } } });
  assert.ok(op && op.op_type === OPS.CAPTURE, "the capture claim committed first");
  const rb = await abortP;
  assert.deepEqual([rb.ok, rb.error], [false, "TEST_ABORT_CAPTURE_NOT_PRISTINE"]);
  const s1 = await snap(b.id);
  assert.deepEqual([s1.version, s1.transitions, s1.applied, s1.claimReleased], [s0.version, s0.transitions, s0.applied, s0.claimReleased], "no transition / event / claim change");
  assert.equal(s1.ops.filter((x) => /cancel_reservation|void_payment_intent|alert\.owner/.test(x)).length, 0, "no cancel / void / alert queued");
});

// ---------- the ACCEPTED compensation worker (fake Stripe + Hostaway) settles the abort ----------
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), voids: [], cancels: [], voidMode: "ok", cancelMode: "ok" };
  w.piObj = (p) => ({ object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount, amount_received: 0,
    amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd", metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
    latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: false, amount: p.amount, amount_captured: 0,
      amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } });
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  w.executors = {
    retrieveAccount: async () => { w.calls.push("ACCOUNT"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id) => { w.calls.push(`PI ${id}`); return w.piObj(w.pis.get(id)); },
    cancelPaymentIntent: async (id, params, o = {}) => {
      w.calls.push(`VOID ${id}`); w.voids.push({ id, key: o.idempotencyKey });
      const p = w.pis.get(id);
      if (w.voidMode === "ok") { p.status = "canceled"; return w.piObj(p); }
      if (w.voidMode === "replyOnly") return { ...w.piObj(p), status: "canceled" };
      throw new Error(w.voidMode);
    },
    retrieveReservation: async (req) => {
      w.calls.push(`RES ${req.path}`);
      const r = w.res.get(Number(/\/reservations\/(\d+)$/.exec(req.path)[1]));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } };
    },
    lookupPage: async (req) => {
      w.calls.push(`LOOKUP ${req.query.listingId}`);
      if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      return { httpStatus: 200, json: { status: "success", result: [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full) } };
    },
    cancelReservation: async (req) => {
      w.calls.push(`CANCEL ${req.path}`); w.cancels.push(req.path);
      const r = w.res.get(Number(/\/reservations\/(\d+)\/statuses\/cancelled$/.exec(req.path)[1]));
      if (w.cancelMode === "ok") { r.status = "cancelled"; return { httpStatus: 200, json: { status: "success", result: full(r) } }; }
      if (w.cancelMode === "replyOnly") return { httpStatus: 200, json: { status: "success", result: { ...full(r), status: "cancelled" } } };
      throw new Error(w.cancelMode);
    }
  };
  return w;
}
function attachWorld(w, a) {
  w.pis.set(a.piId, { id: a.piId, intentId: a.id, attemptId: a.paymentAttemptId, status: "requires_capture", amount: a.intent.payment.amountMinor,
    chargeId: `ch_test_${a.id.slice(0, 8)}`, captureBeforeSec: a.intent.payment.captureBefore / 1000 });
  w.res.set(Number(a.rid), { id: Number(a.rid), listingMapId: LISTING, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.intent.price.finalTotalMinor / 100,
    currency: "USD", status: "new", ref: a.ref });
}
function harness(w) {
  const clk = { t: F.at(20) };
  const opts = (extra = {}) => ({ workerId: "cw1", env: CLEAN_ENV,
    adapterConfig: validateAdapterConfig({ allowedListingIds: [LISTING], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" }),
    listings: new Map([[LISTING, { currency: "USD", timeZone: TZ }]]), executors: w.executors, clock: () => clk.t, stripeAccountId: ACCT, ...extra });
  return { clk, step: (extra = {}) => runCleanupStep(db.app, opts(extra)) };
}

test("D5 the accepted cleanup settles BOTH legs (each on its own proof), claim held until both, ONE void + ONE cancel; capture row untouched; notify / alert only QUEUED", async () => {
  const a = await confirmedIntent();
  F.ok(await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e }));
  const w = world(); attachWorld(w, a);
  const h = harness(w);
  const seen = [];
  for (let k = 0; k < 10 && (await state(a.id)) !== "cancelled"; k++) {
    await h.step({ intentId: a.id }); h.clk.t += MIN;
    seen.push({ legs: await legs(a.id), held: await claimHeld(a.id), st: await state(a.id) });
  }
  assert.equal(await state(a.id), "cancelled", JSON.stringify(seen));
  for (const s of seen.slice(0, -1)) assert.equal(s.held, true, "claim held until both legs are proven");
  assert.ok(seen.some((s) => s.st === "capture_failed" && s.legs[0] !== s.legs[1]), "one leg settled strictly before the other");
  assert.equal(await claimHeld(a.id), false, "released after both proofs");
  assert.deepEqual([w.voids.length, w.cancels.length], [1, 1]);
  assert.equal(w.voids[0].key, `void:${a.id}:${a.piId}`);
  assert.deepEqual(w.cancels, [`/v1/reservations/${a.rid}/statuses/cancelled`]);
  assert.deepEqual((await opsOf(a.id, OPS.CAPTURE)).map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]], "capture row never touched");
  const rest = await opsOf(a.id);
  for (const t of ["guest.notify", "alert.owner"]) for (const o of rest.filter((x) => x.op_type === t)) assert.deepEqual([o.state, o.attempts, o.dispatched_at], ["pending", 0, null], t);
  assert.equal(w.calls.some((c) => /capture|refund/i.test(c)), false);
});

test("D6 either leg first, and unclear outcomes: a reply alone never settles a leg; still-active / still-authorized → owner case, claim held, ZERO resends", async () => {
  // void reply-only (the PaymentIntent stays authorized): the cancel leg settles, the void leg ends in an owner case; no second void
  const a = await confirmedIntent();
  F.ok(await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e }));
  const w = world(); attachWorld(w, a); w.voidMode = "replyOnly";
  const h = harness(w);
  for (let k = 0; k < 25 && !["cancelled", "reconciliation_required"].includes(await state(a.id)); k++) { await h.step({ intentId: a.id }); h.clk.t += 3 * MIN; }
  assert.equal(await state(a.id), "reconciliation_required");
  assert.equal((await legs(a.id))[0], true, "the cancel leg settled first on its own proof");
  assert.equal(await claimHeld(a.id), true, "claim held: the authorization was never proven settled");
  for (let k = 0; k < 4; k++) { h.clk.t += 5 * MIN; await Promise.all([h.step(), h.step({ workerId: "cw2" })]); }
  assert.deepEqual([w.voids.length, (await opsOf(a.id, OPS.VOID)).length], [1, 1], "no resend, no new void row");
  // cancel reply-only (the reservation stays active): the void leg settles first, the cancel leg ends in an owner case; no second cancel
  const b = await confirmedIntent();
  F.ok(await requestTestAbort(db.app, b.id, { now: F.at(9), env: ENV, operator: b.e }));
  const w2 = world(); attachWorld(w2, b); w2.cancelMode = "replyOnly";
  const h2 = harness(w2);
  for (let k = 0; k < 25 && !["cancelled", "reconciliation_required"].includes(await state(b.id)); k++) { await h2.step({ intentId: b.id }); h2.clk.t += 3 * MIN; }
  assert.equal(await state(b.id), "reconciliation_required");
  assert.equal((await legs(b.id))[1], true, "the void leg settled first on its own proof");
  assert.equal(await claimHeld(b.id), true, "claim held: the reservation was never proven cancelled");
  for (let k = 0; k < 4; k++) { h2.clk.t += 5 * MIN; await Promise.all([h2.step(), h2.step({ workerId: "cw2" })]); }
  assert.deepEqual([w2.cancels.length, (await opsOf(b.id, OPS.CANCEL)).length], [1, 1], "no resend, no new cancel row");
  assert.equal([...w.calls, ...w2.calls].some((c) => /capture|refund/i.test(c)), false);
});

test("D7 (root a1dcea0d) the expectation is bound synchronously: mutating the caller's object inside applyEvent (afterLoad: after transition(), before BEGIN / the intent lock, before inTx) cannot change what is checked or written; coerced inputs make ZERO writes", async () => {
  const a = await confirmedIntent();
  const callerObj = { ...a.e };
  let mutated = false;
  // afterLoad fires inside applyEvent AFTER loadIntentRow + transition() and BEFORE BEGIN / the FOR NO KEY UPDATE intent lock (repo.js:353-354 <
  // :364-367); it still runs BEFORE inTx (:390), so an unbound (mutable) expectation would be seen by the in-transaction checks
  const hooks = { afterLoad: async () => { callerObj.expectedVersion = 999; callerObj.paymentIntentId = "pi_ABRTmutatedX01"; callerObj.reservationId = "61999999";
    callerObj.listingId = 603566; callerObj.sessionId = "cs_test_mutatedAbort1"; mutated = true; } };
  const r = await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: callerObj, hooks });
  assert.equal(mutated, true, "the caller object really changed mid-transaction");
  assert.equal(r.ok, true, r.error);
  assert.equal(await state(a.id), "capture_failed");
  const ev = (await db.app.query("SELECT event_id FROM booking.intent_applied_events WHERE intent_id = $1 AND event_id LIKE 'test-abort:%'", [a.id])).rows;
  assert.deepEqual(ev.map((x) => x.event_id), [`test-abort:${a.id}:${a.piId}:${a.rid}`], "event id from the BOUND values");
  // coerced / boxed inputs: refused before any DB work, zero writes
  const b = await confirmedIntent();
  const before = await opsOf(b.id);
  for (const over of [{ paymentIntentId: [b.e.paymentIntentId] }, { sessionId: new String(b.e.sessionId) }, { intentId: [b.e.intentId] }, { attemptId: [b.e.attemptId] },
    { approvalRef: 123 }, { planHash: [b.e.planHash] }]) {
    assert.deepEqual(await requestTestAbort(db.app, b.id, { now: F.at(9), env: ENV, operator: { ...b.e, ...over } }), { ok: false, error: "TEST_ABORT_EXPECTATION_INVALID" }, Object.keys(over)[0]);
  }
  assert.equal(await state(b.id), "reservation_confirmed");
  assert.deepEqual(await opsOf(b.id), before, "zero writes");
});
