// E7 operator TEST abort — throwaway local PostgreSQL (migrations 0001–0016), runtime code as mv_booking_app; FAKE Stripe + Hostaway
// executors for the accepted compensation worker (no network, no SDK, no credentials). db.owner is used ONLY to plant hostile state.
// Every id / amount / guest below is synthetic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
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
async function confirmedIntent(o = {}) {
  const stay = nextStay();
  const p = await F.pending(db.app, stay);
  const piId = `pi_ABRT${hex8()}`;
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }));
  if (o.beforeCreate) await o.beforeCreate(p);                                    // e.g. the pre-create by-ref lookup, BEFORE the create claim (F.at(6))
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

/** a REAL read through the accepted runtime APIs (requestRead → claim → complete → recordProviderEvidence): observed_at = that read's completed_at */
async function readEvidence(intentId, { opType, ref, at, kind, externalRef, status, observed }) {
  const opId = await requestRead(db.app, intentId, opType, ref, { now: at });
  const op = await claimNextOperation(db.app, { workerId: "w-read", now: at, intentId, opId });
  assert.equal(op && op.id, opId);
  F.ok(await completeOperation(db.app, opId, { workerId: "w-read", now: at, outcome: { status: "succeeded" } }));
  const r = await recordProviderEvidence(db.app, { readOpId: opId, kind, externalRef, status, observed });
  assert.equal(r.ok, true, JSON.stringify(r));
  return opId;
}
/** SYNTHETIC (owner-planted, labelled): a row the accepted record_provider_evidence REFUSES (it binds the selector), bound to a REAL succeeded read;
 *  used only to prove the helper ALSO refuses such a mis-bound row if one ever existed. observed_at = that read's completed_at. */
async function plantMisbound(intentId, { opType, ref, at, kind, externalRef, status, observed }) {
  const opId = await requestRead(db.app, intentId, opType, ref, { now: at });
  assert.equal((await claimNextOperation(db.app, { workerId: "w-read", now: at, intentId, opId })).id, opId);
  F.ok(await completeOperation(db.app, opId, { workerId: "w-read", now: at, outcome: { status: "succeeded" } }));
  await assert.rejects(recordProviderEvidence(db.app, { readOpId: opId, kind, externalRef, status, observed }).then((r) => { if (!r.ok) throw new Error(r.error || "refused"); }),
    "the accepted DB API refuses this binding");
  await db.owner.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, read_operation_id, recorded_by_role, recorded_session_user, created_at)
    SELECT $1, $2, $3, 'hostaway_api', $4, $5, $6::jsonb, o.completed_at, o.id, 'test', 'test', now() FROM booking.external_operations o WHERE o.id = $7`,
    [randomUUID(), intentId, kind, externalRef, status, JSON.stringify(observed), opId]);
}
const LOOKUP = "hostaway.lookup_reservation"; const RETRIEVE = "hostaway.retrieve_reservation";
const preCreateAbsence = (at = F.at(5)) => async (p) => {
  const ref = (await loadIntent(db.app, p.id)).ref;
  await readEvidence(p.id, { opType: LOOKUP, ref, at, kind: "hostaway_reservation", externalRef: ref, status: "not_found", observed: { bookingRef: ref, matchCount: 0 } });
};
const boundObserved = (a, over = {}) => ({ reservationId: a.rid, listingId: LISTING, from: a.stay.from, to: a.stay.to, totalMinor: a.e.finalTotalMinor, currency: "USD", status: "new", ...over });
const evRows = async (id) => (await db.app.query("SELECT kind, source, external_ref, status, observed, observed_at, read_operation_id FROM booking.provider_evidence WHERE intent_id = $1 ORDER BY created_at, id", [id])).rows;

test("D8 (root b43935f0) hostaway_reservation history: ALLOWED = the pre-create by-ref not_found (bound lookup, before the ONE create dispatch) and a bound found_active for the exact reservation; history rows preserved unchanged", async () => {
  // P1 the pre-create absence, then the accepted abort; the absence row stays exactly as recorded (tolerated history, never proof of anything now)
  const a = await confirmedIntent({ beforeCreate: preCreateAbsence() });
  const ev0 = await evRows(a.id);
  assert.deepEqual(ev0.map((x) => `${x.kind}:${x.status}:${x.external_ref === a.ref}`), ["hostaway_reservation:not_found:true"]);
  const r = await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(await state(a.id), "capture_failed");
  assert.deepEqual(await evRows(a.id), ev0, "the not_found history row is unchanged");
  // P2 a bound found_active by-id retrieve AND a bound by-ref lookup match (matchCount 1), both for the exact reservation + identity
  const b = await confirmedIntent({ beforeCreate: preCreateAbsence() });
  await readEvidence(b.id, { opType: RETRIEVE, ref: b.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: b.rid, status: "found_active", observed: boundObserved(b) });
  await readEvidence(b.id, { opType: LOOKUP, ref: b.ref, at: F.at(8), kind: "hostaway_reservation", externalRef: b.rid, status: "found_active",
    observed: { bookingRef: b.ref, matchCount: 1, ...boundObserved(b, { bookingRef: b.ref }) } });
  const rb = await requestTestAbort(db.app, b.id, { now: F.at(9), env: ENV, operator: b.e });
  assert.equal(rb.ok, true, JSON.stringify(rb)); assert.equal(await state(b.id), "capture_failed");
});

test("D9 (root b43935f0) every other hostaway_reservation / payment / offline-charge evidence class is TEST_ABORT_EVIDENCE_CONFLICT with ZERO E3 / event / outbox change (fresh disposable intent per case; append-only rows never rewritten)", async () => {
  const cases = [
    ["cancelled for the bound reservation", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "cancelled", observed: {} })],
    ["not_found for the reservation id", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "not_found", observed: {} })],
    ["POST-create not_found for the same booking ref", async (a) => readEvidence(a.id, { opType: LOOKUP, ref: a.ref, at: F.at(8), kind: "hostaway_reservation", externalRef: a.ref, status: "not_found", observed: { bookingRef: a.ref, matchCount: 0 } })],
    ["not_found completed AT the create dispatch (ambiguous order)", null, preCreateAbsence(F.at(6))],
    ["not_found whose external_ref differs from the lookup's ref (mismatched read binding)", null, async (p) => {
      const ref = (await loadIntent(db.app, p.id)).ref;
      await readEvidence(p.id, { opType: LOOKUP, ref, at: F.at(5), kind: "hostaway_reservation", externalRef: "MV-NOT-THIS-REF", status: "not_found", observed: { bookingRef: ref, matchCount: 0 } }); }],
    ["not_found with an observed bookingRef of another booking", null, async (p) => {
      const ref = (await loadIntent(db.app, p.id)).ref;
      await plantMisbound(p.id, { opType: LOOKUP, ref, at: F.at(5), kind: "hostaway_reservation", externalRef: ref, status: "not_found", observed: { bookingRef: "MV-OTHER", matchCount: 0 } }); }],
    ["not_found recorded from a by-id retrieve (not the by-ref lookup)", null, async (p) => {
      const ref = (await loadIntent(db.app, p.id)).ref;
      await plantMisbound(p.id, { opType: RETRIEVE, ref: "61000001", at: F.at(5), kind: "hostaway_reservation", externalRef: ref, status: "not_found", observed: { bookingRef: ref, matchCount: 0 } }); }],
    ["found_active for ANOTHER reservation", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: "61999998", at: F.at(8), kind: "hostaway_reservation", externalRef: "61999998", status: "found_active", observed: boundObserved(a, { reservationId: "61999998" }) })],
    ["found_active, contradictory total", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { totalMinor: a.e.finalTotalMinor + 100 }) })],
    ["found_active, contradictory stay", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { to: addDays(a.stay.to, 1) }) })],
    ["found_active, contradictory listing", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { listingId: 603566 }) })],
    ["found_active, contradictory currency", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { currency: "MXN" }) })],
    ["found_active, contradictory bookingRef", async (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { bookingRef: "MV-OTHER" }) })],
    ["found_active, retrieve of a DIFFERENT id recorded under the bound id", async (a) => plantMisbound(a.id, { opType: RETRIEVE, ref: "61999997", at: F.at(8), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a) })],
    ["SYNTHETIC owner-planted dashboard row (missing read binding)", async (a) => db.owner.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, attested_by, reference, recorded_by_role, recorded_session_user, created_at)
      VALUES ($1, $2, 'hostaway_reservation', 'hostaway_dashboard', $3, 'not_found', $4::jsonb, now(), 'test-owner', 'SYNTHETIC unbound row', 'test', 'test', now())`, [randomUUID(), a.id, a.ref, JSON.stringify({ bookingRef: a.ref, matchCount: 0 })])],
    ["payment_intent evidence for ANOTHER PI", async (a) => readEvidence(a.id, { opType: "stripe.retrieve_payment_intent", ref: "pi_ABRTotherPI0001", at: F.at(8), kind: "payment_intent", externalRef: "pi_ABRTotherPI0001", status: "requires_capture", observed: {} })],
    ["payment_intent observed captured", async (a) => readEvidence(a.id, { opType: "stripe.retrieve_payment_intent", ref: a.piId, at: F.at(8), kind: "payment_intent", externalRef: a.piId, status: "succeeded", observed: {} })],
    ["payment_intent observed canceled", async (a) => readEvidence(a.id, { opType: "stripe.retrieve_payment_intent", ref: a.piId, at: F.at(8), kind: "payment_intent", externalRef: a.piId, status: "canceled", observed: {} })],
    // a REAL offline-charge read is already refused one gate earlier (its op type is not tolerated history): still zero effects
    ["offline-charge evidence via a real read (earlier history gate)", async (a) => readEvidence(a.id, { opType: "hostaway.list_offline_charges", ref: a.rid, at: F.at(8), kind: "hostaway_offline_charges", externalRef: a.rid, status: "listed", observed: { matchingChargeCount: 0, matchingChargeIds: [] } }), null, "TEST_ABORT_OPERATION_HISTORY"],
    ["SYNTHETIC owner-planted attested offline-charge row (reaches the evidence gate)", async (a) => db.owner.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, attested_by, reference, recorded_by_role, recorded_session_user, created_at)
      VALUES ($1, $2, 'hostaway_offline_charges', 'hostaway_dashboard', $3, 'listed', '{"matchingChargeCount":0,"matchingChargeIds":[]}'::jsonb, now(), 'test-owner', 'SYNTHETIC attested row', 'test', 'test', now())`, [randomUUID(), a.id, a.rid])]
  ];
  const ran = [];
  for (const [label, after, beforeCreate, want = "TEST_ABORT_EVIDENCE_CONFLICT"] of cases) {
    let a;
    try { a = await confirmedIntent(beforeCreate ? { beforeCreate } : {}); if (after) await after(a); }
    catch (err) { ran.push(`${label}: SETUP_REFUSED_BY_ACCEPTED_API ${String(err && (err.code || err.message)).slice(0, 80)}`); continue; }
    const s0 = await snap(a.id); const ev0 = await evRows(a.id);
    assert.ok(ev0.length >= 1, label);
    const r = await requestTestAbort(db.app, a.id, { now: F.at(9), env: ENV, operator: a.e });
    assert.deepEqual([r.ok, r.error], [false, want], label);
    assert.deepEqual(await snap(a.id), s0, `${label}: zero E3 / event / outbox change`);
    assert.deepEqual(await evRows(a.id), ev0, `${label}: evidence unchanged`);
    ran.push(`${label}: ${want === "TEST_ABORT_EVIDENCE_CONFLICT" ? "CONFLICT" : want}`);
  }
  console.log(`# D9 ${JSON.stringify(ran)}`);
  assert.deepEqual(ran.filter((x) => !x.endsWith(": CONFLICT") && !x.endsWith(": TEST_ABORT_OPERATION_HISTORY")), [], "every disallowed class was represented and refused");
});

// ---- E7 r02 candidate: recovered (reconciled_found) reservation provenance ------------------------------------------------------------
/** the r02-shaped lineage, through accepted APIs only: STARTED (2-min lease) → DISPATCHED → create reply WITHOUT the booking ref → the ONE
 *  create op SUCCEEDED with result_ref = the provider id (ref-not-echoed path) → lease expires → RECOVER_INTERRUPTED (queues the by-ref
 *  lookup) → that lookup + a by-id retrieve succeed with bound found_active evidence → RECONCILED_RESERVATION_FOUND → reservation_confirmed.
 *  o.resultRef overrides the create result_ref; o.noFoundActive skips the found_active evidence (records nothing for the reads). */
async function reconciledIntent(o = {}) {
  const stay = nextStay();
  const p = await F.pending(db.app, stay);
  const piId = `pi_ABRT${hex8()}`;
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  const rid = F.nextReservationId() + 61000000;
  const ref = (await loadIntent(db.app, p.id)).ref;
  const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: { ...F.reservationFor(stay, rid), bookingRef: null } }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: o.resultRef ?? rid } }));
  F.ok(await applyEvent(db.app, p.id, { type: "RECOVER_INTERRUPTED", id: `recover:${p.id}:test` }, { now: F.at(9), actor: "reconciler" }));
  assert.equal(await state(p.id), "reservation_unknown");
  const observed = { reservationId: String(rid), listingId: LISTING, from: stay.from, to: stay.to, totalMinor: (await loadIntent(db.app, p.id)).price.finalTotalMinor, currency: "USD", status: "new" };
  // the RECOVERY lookup queued by RECOVER_INTERRUPTED, then a by-id retrieve (both real reads through the accepted APIs)
  const lk = await claimNextOperation(db.app, { workerId: "w-rec", now: F.at(10), intentId: p.id, opTypes: [LOOKUP] });
  assert.ok(lk, "recovery lookup queued");
  F.ok(await completeOperation(db.app, lk.id, { workerId: "w-rec", now: F.at(10), outcome: { status: "succeeded" } }));
  if (!o.noFoundActive) {
    F.ok(await recordProviderEvidence(db.app, { readOpId: lk.id, kind: "hostaway_reservation", externalRef: String(rid), status: "found_active",
      observed: { bookingRef: ref, matchCount: 1, ...observed, bookingRef: ref } }));
    if (!o.noById) await readEvidence(p.id, { opType: RETRIEVE, ref: String(rid), at: F.at(10), kind: "hostaway_reservation", externalRef: String(rid), status: "found_active", observed });
  }
  F.ok(await applyEvent(db.app, p.id, { type: "RECONCILED_RESERVATION_FOUND", id: `recon:${p.id}:test`, reservation: F.reservationFor(stay, rid) }, { now: F.at(11), actor: "reconciler" }));
  const i = await loadIntent(db.app, p.id);
  assert.equal(i.status, "reservation_confirmed");
  const att = (await db.app.query("SELECT state, hostaway_reservation_id FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [p.id])).rows;
  assert.deepEqual(att.map((x) => [x.state, String(x.hostaway_reservation_id)]), [["reconciled_found", String(rid)]]);
  const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [p.id])).rows[0].id;
  const e = buildAbortExpectation({ intentId: p.id, expectedVersion: i.version, listingId: LISTING, from: stay.from, to: stay.to, guests: i.guests, currency: "USD",
    finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: piId, sessionId: p.sessionId, attemptId: pa,
    reservationId: String(rid), approvalRef: "synthetic-abort-reconciled" });
  assert.ok(e, "expectation builds");
  return { id: p.id, piId, rid: String(rid), stay, e, intent: i, ref, paymentAttemptId: pa };
}

test("D10 (r02 candidate) RECOVERED reservation: reconciled_found + the ONE succeeded create (result_ref = id) + bound found_active → ONE abort event, same effects as D1; then the accepted cleanup settles BOTH legs once", async () => {
  const a = await reconciledIntent();
  const s0 = await snap(a.id);
  assert.equal((await classify(db.app, a.e)).class, "ELIGIBLE");
  const r = await requestTestAbort(db.app, a.id, { now: F.at(12), env: ENV, operator: a.e });
  assert.equal(r.ok, true, JSON.stringify(r));
  const i = await loadIntent(db.app, a.id);
  assert.deepEqual([i.status, i.reasonCode, i.version], ["capture_failed", TEST_ABORT_REASON, s0.version.version + 1]);
  const after1 = await snap(a.id);
  const added = after1.ops.filter((x) => !s0.ops.includes(x) || after1.ops.filter((y) => y === x).length > s0.ops.filter((y) => y === x).length);
  assert.deepEqual(added.sort(), ["alert.owner:pending:0:true", "hostaway.cancel_reservation:pending:0:true", "stripe.void_payment_intent:pending:0:true"]);
  assert.deepEqual((await opsOf(a.id, OPS.CAPTURE)).map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]]);
  const again = await requestTestAbort(db.app, a.id, { now: F.at(13), env: ENV, operator: a.e });
  assert.deepEqual([again.ok, again.duplicate], [true, true]);
  // the accepted two-leg cleanup, unchanged
  const w = world(); attachWorld(w, a);
  const h = harness(w);
  for (let k = 0; k < 10 && (await state(a.id)) !== "cancelled"; k++) { await h.step({ intentId: a.id }); h.clk.t += MIN; }
  assert.equal(await state(a.id), "cancelled");
  assert.deepEqual([w.voids.length, w.cancels.length], [1, 1]);
  assert.deepEqual(w.cancels, [`/v1/reservations/${a.rid}/statuses/cancelled`]);
  assert.equal(await claimHeld(a.id), false);
  assert.equal(w.calls.some((c) => /capture|refund/i.test(c)), false);
});

test("D11 (r02 candidate) recovered provenance still refuses with ZERO writes: no found_active evidence; create result_ref ≠ bound id; found_active for another id; and the original 'succeeded'-only RED is now the only behaviour change", async () => {
  // (a) reconciled_found but NO bound found_active evidence
  const a = await reconciledIntent({ noFoundActive: true });
  let s0 = await snap(a.id);
  let r = await requestTestAbort(db.app, a.id, { now: F.at(12), env: ENV, operator: a.e });
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"]); assert.deepEqual(await snap(a.id), s0);
  // (a2) reconciled_found with ONLY the by-ref lookup found_active (no post-create by-id retrieve proof)
  const a2 = await reconciledIntent({ noById: true });
  s0 = await snap(a2.id);
  r = await requestTestAbort(db.app, a2.id, { now: F.at(12), env: ENV, operator: a2.e });
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"]); assert.deepEqual(await snap(a2.id), s0);
  // (b) the create's own result_ref is ANOTHER id, built through the accepted APIs (no catch: the fixture MUST build, the guard MUST refuse)
  const b = await reconciledIntent({ resultRef: 61999990 });
  assert.equal((await db.app.query("SELECT result_ref FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [b.id])).rows[0].result_ref, "61999990");
  s0 = await snap(b.id);
  r = await requestTestAbort(db.app, b.id, { now: F.at(12), env: ENV, operator: b.e });
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"]); assert.deepEqual(await snap(b.id), s0);
  // (b2) independent SYNTHETIC owner-fault fixture: a fully valid recovered intent whose create result_ref is then rewritten by the owner role
  //      (labelled, triggers disabled only for this planted state) → the candidate guard alone must refuse, zero writes
  const b2 = await reconciledIntent();
  await db.owner.query("ALTER TABLE booking.external_operations DISABLE TRIGGER USER");
  try { await db.owner.query("UPDATE booking.external_operations SET result_ref = '61999991' WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [b2.id]); }
  finally { await db.owner.query("ALTER TABLE booking.external_operations ENABLE TRIGGER USER"); }
  s0 = await snap(b2.id);
  r = await requestTestAbort(db.app, b2.id, { now: F.at(12), env: ENV, operator: b2.e });
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"]); assert.deepEqual(await snap(b2.id), s0);
  // (c) an extra found_active for ANOTHER reservation → evidence conflict
  const c = await reconciledIntent();
  await readEvidence(c.id, { opType: RETRIEVE, ref: "61999998", at: F.at(11), kind: "hostaway_reservation", externalRef: "61999998", status: "found_active",
    observed: boundObserved(c, { reservationId: "61999998" }) });
  s0 = await snap(c.id);
  r = await requestTestAbort(db.app, c.id, { now: F.at(12), env: ENV, operator: c.e });
  assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_EVIDENCE_CONFLICT"]); assert.deepEqual(await snap(c.id), s0);
  // (d) other attempt states still refuse (owner-planted SYNTHETIC: escalated / outcome_unknown)
  for (const st of ["escalated", "outcome_unknown"]) {
    const d = await confirmedIntent();
    await db.owner.query("ALTER TABLE booking.hostaway_reservation_attempts DISABLE TRIGGER USER");
    try { await db.owner.query("UPDATE booking.hostaway_reservation_attempts SET state = $2 WHERE intent_id = $1", [d.id, st]); }
    finally { await db.owner.query("ALTER TABLE booking.hostaway_reservation_attempts ENABLE TRIGGER USER"); }
    s0 = await snap(d.id);
    r = await requestTestAbort(db.app, d.id, { now: F.at(9), env: ENV, operator: d.e });
    assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"], st); assert.deepEqual(await snap(d.id), s0, st);
  }
});

test("D12 (r02 candidate, ROOT F1) positivity comes ONLY from the one validated evidence read; ZERO writes otherwise", async () => {
  const EVQ = "SELECT kind, source, external_ref, status, observed, observed_at, read_operation_id FROM booking.provider_evidence WHERE intent_id = $1";
  const insertById = async (a, opId, observed, c = db.owner) => c.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, read_operation_id, recorded_by_role, recorded_session_user, created_at)
      SELECT $1, $2, 'hostaway_reservation', 'hostaway_api', $3, 'found_active', $4::jsonb, o.completed_at, o.id, 'test', 'test', now() FROM booking.external_operations o WHERE o.id = $5`,
      [randomUUID(), a.id, a.rid, JSON.stringify(observed), opId]);
  const succeededRetrieve = async (a) => {                                     // a REAL succeeded post-create by-id retrieve of the bound id (allowed history)
    const opId = await requestRead(db.app, a.id, RETRIEVE, a.rid, { now: F.at(10) });
    assert.equal((await claimNextOperation(db.app, { workerId: "w-read", now: F.at(10), intentId: a.id, opId })).id, opId);
    F.ok(await completeOperation(db.app, opId, { workerId: "w-read", now: F.at(10), outcome: { status: "succeeded" } }));
    return opId;
  };
  const hooked = (onEv) => ({ query: (...q) => db.app.query(...q), connect: async () => {
    const cl = await db.app.connect();
    return new Proxy(cl, { get(tg, k) {
      if (k === "query") return async (...q) => { const res = await tg.query(...q); return typeof q[0] === "string" && q[0] === EVQ ? await onEv(res) : res; };
      const v = tg[k]; return typeof v === "function" ? v.bind(tg) : v; } });
  } });

  // (a) DB fence: an evidence insert concurrent with the open abort transaction (issued right after its evidence read) cannot
  //     commit inside the window; it waits on the abort transaction, which refuses and writes nothing.
  {
    const a = await reconciledIntent({ noById: true });
    const opId = await succeededRetrieve(a);
    const s0 = await snap(a.id);
    let fence = null;
    const r = await requestTestAbort(hooked(async (res) => {
      if (fence === null) {
        const oc = await db.owner.connect();
        try { await oc.query("BEGIN"); await oc.query("SET LOCAL lock_timeout = '1500ms'"); await insertById(a, opId, boundObserved(a), oc); await oc.query("COMMIT"); fence = "committed"; }
        catch (err) { await oc.query("ROLLBACK").catch(() => {}); fence = err.code; } finally { oc.release(); }
      }
      return res;
    }), a.id, { now: F.at(12), env: ENV, operator: a.e });
    assert.equal(fence, "55P03", "the concurrent insert is blocked by the open abort transaction (lock_not_available)");
    assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"]); assert.deepEqual(await snap(a.id), s0);
  }

  // (b) code binding, independent of that fence: the by-id found_active row is COMMITTED and visible to every later statement of the
  //     abort transaction, but absent from the one validated evidence read (SYNTHETIC snapshot gap) → refusal, ZERO writes.
  //     Against candidate 778b19cd (second pos query) this case was accepted: that is the F1 RED.
  for (const variant of ["matching-identity", "conflicting-identity"]) {
    const a = await reconciledIntent({ noById: true });
    const opId = await succeededRetrieve(a);
    await insertById(a, opId, variant === "matching-identity" ? boundObserved(a) : boundObserved(a, { totalMinor: a.e.finalTotalMinor + 100 }));
    const s0 = await snap(a.id);
    let hid = 0;
    const r = await requestTestAbort(hooked(async (res) => {
      const rows = res.rows.filter((x) => String(x.read_operation_id) !== String(opId)); hid += res.rows.length - rows.length; return { ...res, rows, rowCount: rows.length };
    }), a.id, { now: F.at(12), env: ENV, operator: a.e });
    assert.equal(hid, 1, `${variant}: the committed row was withheld from the validated read only`);
    assert.deepEqual([r.ok, r.error], [false, "TEST_ABORT_RESERVATION_HISTORY"], variant);
    assert.deepEqual(await snap(a.id), s0, `${variant}: zero E3 / op / claim change`);
    // unhooked: the same row is classified on its own merits (conflict → EVIDENCE_CONFLICT; matching → the one accepted abort)
    const r2 = await requestTestAbort(db.app, a.id, { now: F.at(13), env: ENV, operator: a.e });
    if (variant === "conflicting-identity") assert.deepEqual([r2.ok, r2.error], [false, "TEST_ABORT_EVIDENCE_CONFLICT"]);
    else assert.equal(r2.ok, true, JSON.stringify(r2));
  }
});

test("D13 (r02 candidate) new positive path: identity / timestamp / order refusals (fresh intent per case; ZERO writes)", async () => {
  const cases = [
    ["by-id found_active with contradictory total", (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(10), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { totalMinor: a.e.finalTotalMinor + 1 }) }), "TEST_ABORT_EVIDENCE_CONFLICT"],
    ["by-id found_active with contradictory stay", (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(10), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a, { to: addDays(a.stay.to, 1) }) }), "TEST_ABORT_EVIDENCE_CONFLICT"],
    ["by-id found_active completed BEFORE the create dispatch", (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(5), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a) }), "TEST_ABORT_RESERVATION_HISTORY"],
    ["by-id found_active completed AT the create dispatch (not strictly after)", (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(6), kind: "hostaway_reservation", externalRef: a.rid, status: "found_active", observed: boundObserved(a) }), "TEST_ABORT_RESERVATION_HISTORY"],
    ["by-id cancelled for the bound id", (a) => readEvidence(a.id, { opType: RETRIEVE, ref: a.rid, at: F.at(10), kind: "hostaway_reservation", externalRef: a.rid, status: "cancelled", observed: {} }), "TEST_ABORT_EVIDENCE_CONFLICT"]
  ];
  for (const [label, add, want] of cases) {
    const a = await reconciledIntent({ noById: true });
    await add(a);
    const s0 = await snap(a.id);
    const r = await requestTestAbort(db.app, a.id, { now: F.at(12), env: ENV, operator: a.e });
    assert.deepEqual([r.ok, r.error], [false, want], label);
    assert.deepEqual(await snap(a.id), s0, `${label}: zero writes`);
  }
});
