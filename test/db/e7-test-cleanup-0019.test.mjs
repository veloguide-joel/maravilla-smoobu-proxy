// 0019 (LOCAL MIGRATION CANDIDATE, ROOT review 5878146178 F1) — TEST cleanup of a CAPTURED TEST payment: cancel + FULL refund with an
// evidence-bound settlement path through the claim-release blockers. Throwaway local PostgreSQL only.
//   REAL      = reached through the accepted repo / operations / evidence API (applyEvent, claimNextOperation, completeOperation,
//               requestRead, recordProviderEvidence) as mv_booking_app; no direct state writes.
//   SYNTHETIC = owner-written malformed rows INSIDE a transaction that is ROLLED BACK, only to evaluate the blockers on shapes the runnable
//               path cannot produce. Never committed.
// Mock Refund / PaymentIntent observations are FIXTURE data shaped like the accepted v3 observation; they are NOT provider proof.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence, settleOperationFromEvidence } from "../../lib/booking-db/operations.js";
import { requestTestCleanup, bindCleanupExpectation, testCleanupGate, TEST_CLEANUP_EXPECTATION_KEYS } from "../../lib/booking-db/test-cleanup.js";
import { migrateUp, migrateDown } from "../../db/lib/migrate.js";
import { transition, EVENTS, STATES, TERMINAL_STATES, refundKey, testCleanupEventId, publicStatus, allowedEvents } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const CAP = "stripe.capture_payment_intent", REFUND = "stripe.refund_payment_intent", CANCEL = "hostaway.cancel_reservation", RECORD = "hostaway.record_offline_charge";
const LIST = 606998; const AMT = 576000; const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" });
const held = async (id, pool = db.app) => (await F.count(pool, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])) === 1;
const blockers = (id, pool = db.app) => claimReleaseBlockers(pool, id);
const rows = async (id, type, pool = db.app) => (await pool.query(`SELECT id, state, attempts, dispatched_at, lease_worker_id, lease_until, result_ref, payload
  FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id`, [id, type])).rows;
const refundRecords = async (id, pool = db.app) => (await pool.query("SELECT seq, idempotency_key, state, hostaway_state, amount_minor::text AS amt, currency, stripe_refund_id, reason_code, requested_by FROM booking.payment_refunds WHERE intent_id = $1 ORDER BY seq", [id])).rows;
const ledger = async (id, pool = db.app) => (await pool.query("SELECT entry, amount_minor::text AS amt, currency, provider, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows;
const captured = async (id, pool = db.app) => (await pool.query("SELECT captured_minor::text AS c, state, reason_code, version FROM booking.intents WHERE id = $1", [id])).rows[0];

/** REAL: a CAPTURED TEST payment on 606998 / USD (F.captured with a CHARGE id as the capture result, as the accepted capture worker records it). */
let stayN = 0;
async function capturedUSD(pool = db.app) {
  stayN += 1;
  const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-05-01", 3 * stayN), to: F.addDays("2027-05-01", 3 * stayN + 2) };
  const r = await F.reserved(pool, stay);
  const chargeId = `ch_test_${r.id.replace(/-/g, "").slice(0, 16)}`;
  const op = await F.claimOp(pool, r.id, CAP, F.at(8));
  F.ok(await completeOperation(pool, op.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: chargeId } }), "capture op");
  F.ok(await applyEvent(pool, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
  const intent = await loadIntent(pool, r.id);
  assert.equal(intent.status, "payment_captured");
  return { ...r, chargeId, intent, stay };
}
async function expectationFor(c, over = {}, pool = db.app) {
  const i = await loadIntent(pool, c.id);
  return Object.freeze({ approvalRef: "SYNTHETIC-cleanup", attemptId: c.attemptId, authorizedMinor: i.payment.amountMinor, capturedMinor: i.payment.capturedMinor, chargeId: c.chargeId,
    currency: i.price.currency, expectedVersion: i.version, finalTotalMinor: i.price.finalTotalMinor, from: i.from, guests: i.guests, intentId: c.id, listingId: i.listingId,
    paymentIntentId: c.piId, planHash: "0".repeat(64), reservationId: String(c.reservationId), sessionId: c.sessionId, to: i.to, ...over });
}
const request = (c, over = {}, env = ENV, pool = db.app) => expectationFor(c, over, pool).then((operator) => requestTestCleanup(pool, c.id, { now: F.at(20), env, operator }));

// ---- REAL legs (accepted operations + evidence API) ----
const piObserved = (c, o = {}) => ({ proofVersion: "pi-proof-v3", object: "payment_intent", paymentIntentId: c.piId, accountVerified: true, livemode: false, metadataIntentId: c.id,
  metadataAttemptId: c.attemptId, captureMethod: "manual", status: "succeeded", amountMinor: AMT, amountReceivedMinor: AMT, amountCapturableMinor: 0, currency: "USD",
  latestCharge: { object: "charge", id: c.chargeId, paymentIntent: c.piId, status: "succeeded", captured: true, amountMinor: AMT, amountCapturedMinor: AMT, amountRefundedMinor: o.refunded ?? AMT,
    currency: "USD", livemode: false, paid: true, captureBefore: null }, ...o.top });
const refundObserved = (c, re, o = {}) => ({ refundId: re, paymentIntentId: o.pi ?? c.piId, chargeId: o.charge ?? c.chargeId, amountMinor: o.amount ?? AMT, currency: o.currency ?? "USD",
  status: o.status ?? "succeeded", created: o.created ?? Math.floor(F.at(22) / 1000) });
async function piRead(c, t, o = {}, pool = db.app) { const id = await F.completedRead(pool, c.id, "stripe.retrieve_payment_intent", c.piId, F.at(t)); return F.readEvidenceOf(pool, id, "payment_intent", c.piId, o.status ?? "succeeded", piObserved(c, o)); }
async function refundRead(c, re, t, o = {}, pool = db.app) {
  const id = await requestRead(pool, c.id, "stripe.retrieve_refund", re, { now: F.at(t) });
  assert.ok(await claimNextOperation(pool, { workerId: "w-read", now: F.at(t), opId: id }), "refund read claimable");
  F.ok(await completeOperation(pool, id, { workerId: "w-read", now: F.at(t), outcome: { status: "succeeded" } }), "refund read");
  return recordProviderEvidence(pool, { readOpId: id, kind: "stripe_refund", externalRef: re, status: o.status ?? "succeeded", observed: refundObserved(c, re, o) });
}
/** the refund SEND (claim → mock reply → complete), as the future cleanup runner would do it; `re` = the provider's refund id */
async function refundSend(c, re, t, outcome = { status: "succeeded" }, pool = db.app) {
  const op = await claimNextOperation(pool, { workerId: "w-cleanup", now: F.at(t), intentId: c.id, opTypes: [REFUND] });
  assert.ok(op, "refund row claimable");
  assert.equal(op.payload.providerIdempotencyKey, refundKey(c.id, 1), "the Stripe Idempotency-Key IS the payment_refunds key");
  F.ok(await completeOperation(pool, op.id, { workerId: "w-cleanup", now: F.at(t), outcome: outcome.status === "succeeded" ? { status: "succeeded", resultRef: re } : outcome }), "refund op");
  return op;
}
async function refundLeg(c, t, { re = `re_test_${c.id.replace(/-/g, "").slice(0, 12)}`, ev = {}, pi = {} } = {}, pool = db.app) {
  await refundSend(c, re, t, { status: "succeeded" }, pool);
  F.ok(await refundRead(c, re, t + 1, ev, pool), "refund evidence");
  await piRead(c, t + 1, pi, pool);
  return { re, r: await applyEvent(pool, c.id, { type: "REFUND_SUCCEEDED", id: `refund-ok:${c.id}`, refundId: re, chargeId: c.chargeId, amountMinor: AMT, currency: "usd" }, { now: F.at(t + 2), actor: "worker", workerId: "w-cleanup" }) };
}
async function cancelLeg(c, t, pool = db.app) {
  await F.runOp(pool, c.id, CANCEL, t, { status: "succeeded" }, "w-cleanup");
  await F.reservationStatus(pool, c.id, String(c.reservationId), "cancelled", {}, t);
  return applyEvent(pool, c.id, { type: "RESERVATION_CANCELLED", id: `cancel-ok:${c.id}` }, { now: F.at(t) });
}

// =============================================================================================
test("R0 RED (F1 reproduction on the UNCHANGED 0018 blockers, fresh cluster): a CAPTURED TEST payment that is fully refunded in every way the 0018 schema can express still blocks the claim with AUTHORIZATION_UNSETTLED; 0019 vocabulary is refused there", async () => {
  const fresh = await startPostgres(); const admin = new pg.Client({ connectionString: fresh.adminUrl }); await admin.connect();
  let app = null;
  try {
    assert.deepEqual((await migrateUp(admin, { env: "test", to: 18 })).at(-1), 18);
    await admin.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    app = new pg.Pool({ connectionString: fresh.appUrl(), max: 4 });
    const c = await capturedUSD(app);
    // everything 0018 CAN record about a full refund: a refund_succeeded ledger entry, a payment_refunds record, and a PI read showing amount_refunded = captured
    const re = "re_test_red0018";
    await app.query(`INSERT INTO booking.payment_refunds (id, intent_id, seq, idempotency_key, stripe_refund_id, amount_minor, currency, reason_code, requested_by, state, hostaway_state, created_at, updated_at)
                     VALUES (gen_random_uuid(), $1, 1, $2, $3, $4, 'USD', 'TEST_CLEANUP', 'admin', 'succeeded', 'pending', now(), now())`, [c.id, refundKey(c.id, 1), re, AMT]);
    await app.query(`INSERT INTO booking.payment_ledger (intent_id, entry, amount_minor, currency, provider, provider_ref, source, at) VALUES ($1, 'refund_succeeded', $2, 'USD', 'stripe', $3, 'red', now())`, [c.id, AMT, re]);
    await piRead(c, 22, {}, app);
    const auth = (await app.query("SELECT booking.authorization_blockers($1) AS b", [c.id])).rows[0].b;
    assert.deepEqual(auth, [`AUTHORIZATION_UNSETTLED:${c.piId}`], "RED: 0018 authorization_blockers cannot settle a refunded captured PI");
    // and the 0019 vocabulary does not exist at 0018 (the settlement path is NOT expressible)
    await assert.rejects(app.query("SELECT booking.test_refund_settled_for($1, $2)", [c.id, c.piId]), /does not exist/);
    await assert.rejects(requestRead(app, c.id, "stripe.retrieve_refund", re, { now: F.at(23) }), /external_operations_op_type_check/);
    assert.deepEqual(await transition(c.intent, { type: "TEST_CLEANUP_REQUESTED", id: "x", paymentIntentId: c.piId, reservationId: String(c.reservationId), chargeId: c.chargeId }, { now: F.at(20), config: {} }).ok, false, "reducer gate closed by default");
  } finally { if (app) await app.end().catch(() => {}); await admin.end(); fresh.stop(); }
});

test("S1 static: the state machine addition is explicit and gated — new state / events / routes; terminal states unchanged; TEST_CLEANUP_REQUESTED refused unless the caller config enables it and every binding matches", () => {
  assert.equal(STATES.TEST_CLEANUP_PENDING, "test_cleanup_pending");
  for (const e of ["TEST_CLEANUP_REQUESTED", "REFUND_SUCCEEDED", "REFUND_OUTCOME_UNKNOWN", "REFUND_FAILED"]) assert.ok(EVENTS.includes(e), e);
  assert.deepEqual(TERMINAL_STATES, ["confirmed", "validation_failed", "expired", "payment_failed", "payment_expired", "authorization_released", "cancelled"]);
  assert.ok(allowedEvents("payment_captured").includes("TEST_CLEANUP_REQUESTED"));
  assert.deepEqual(allowedEvents("test_cleanup_pending").sort(), ["ESCALATE", "PAYMENT_AUTHORIZED", "RECONCILED_RESERVATION_STILL_ACTIVE", "REFUND_FAILED", "REFUND_OUTCOME_UNKNOWN", "REFUND_SUCCEEDED",
    "RESERVATION_CANCELLED", "RESERVATION_CANCEL_FAILED", "RESERVATION_CANCEL_OUTCOME_UNKNOWN"]);
  assert.equal(refundKey("11111111-2222-4333-8444-555555555555"), "ref:11111111-2222-4333-8444-555555555555:1");
  assert.equal(testCleanupGate({ VERCEL_ENV: "production", MV_E7_TEST_CLEANUP: "enabled" }).ok, false);
  assert.equal(testCleanupGate({ VERCEL_ENV: "development" }).ok, false);
  assert.equal(bindCleanupExpectation({}), null);
  assert.equal(TEST_CLEANUP_EXPECTATION_KEYS.length, 17);
});

test("Q1 REAL request: payment_captured → test_cleanup_pending with EXACTLY one cancel row + one refund row (key ref:<intent>:1, bound PI / charge / exact amount / USD); the pristine recording row is retired in the SAME transaction; ONE payment_refunds record (requested, not_applicable); capturedMinor and the capture row / ledger untouched; nothing queued for notification; a replay is a duplicate; the claim stays held", async () => {
  const c = await capturedUSD();
  const rec0 = await rows(c.id, RECORD); assert.deepEqual(rec0.map((o) => [o.state, o.attempts, o.dispatched_at]), [["pending", 0, null]], "recording queued pristine before");
  const cap0 = await rows(c.id, CAP); const led0 = await ledger(c.id);
  const r = await request(c);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.duplicate, false);
  assert.deepEqual(r.operations.map((o) => `${o.opType}:${o.inserted}`).sort(), ["hostaway.cancel_reservation:true", "stripe.refund_payment_intent:true"]);
  const i = await loadIntent(db.app, c.id);
  assert.deepEqual([i.status, i.reasonCode, i.settlement, i.payment.capturedMinor, i.counters.cancelAttempts], ["test_cleanup_pending", "TEST_CLEANUP_REQUESTED", { reservationCancelled: false, authorizationSettled: false }, AMT, 1]);
  assert.equal(publicStatus(i), "processing");
  const rf = await rows(c.id, REFUND);
  assert.deepEqual(rf.map((o) => [o.state, o.attempts, o.payload]), [["pending", 0, { paymentIntentId: c.piId, chargeId: c.chargeId, amountMinor: AMT, currency: "USD", attempt: 1, providerIdempotencyKey: refundKey(c.id, 1) }]]);
  assert.deepEqual((await rows(c.id, RECORD)).map((o) => [o.state, o.attempts, o.dispatched_at, o.result_ref]), [["superseded", 0, null, null]], "retired, never dispatched");
  assert.deepEqual(await rows(c.id, CAP), cap0, "capture row byte-identical"); assert.deepEqual(await ledger(c.id), led0, "ledger unchanged by the request");
  assert.deepEqual(await refundRecords(c.id), [{ seq: 1, idempotency_key: refundKey(c.id, 1), state: "requested", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: null, reason_code: "TEST_CLEANUP", requested_by: "admin" }]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('guest.notify', 'alert.owner')", [c.id])).rows[0].n, 0, "nothing queued for anyone");
  assert.equal(await held(c.id), true);
  assert.deepEqual(await blockers(c.id), ["STATE_NOT_RELEASABLE:test_cleanup_pending"]);
  const again = await request(c, { expectedVersion: c.intent.version });            // the same operator expectation (old version) replays the same event id
  assert.deepEqual([again.ok, again.duplicate], [true, true], JSON.stringify(again));
  assert.equal((await rows(c.id, REFUND)).length, 1);
});

test("Q2 REAL refusals (ZERO writes): gate closed / production; wrong state; stale version; wrong charge / PI / amount / reservation / listing; protected id; recording already dispatched; recording already succeeded; a notification row; an open case; a non-TEST intent (owner synthetic, rolled back)", async () => {
  const unchanged = async (c, r, code) => { assert.deepEqual([r.ok, r.error], [false, code], JSON.stringify(r)); const i = await loadIntent(db.app, c.id); assert.equal(i.status, "payment_captured", code);
    assert.deepEqual((await rows(c.id, RECORD)).map((o) => o.state), ["pending"], `${code}: recording untouched`); assert.equal((await rows(c.id, REFUND)).length, 0, code); assert.deepEqual(await refundRecords(c.id), [], code); };
  const c = await capturedUSD();
  await unchanged(c, await request(c, {}, { VERCEL_ENV: "production", MV_E7_TEST_CLEANUP: "enabled" }), "TEST_CLEANUP_GATE_CLOSED");
  await unchanged(c, await request(c, {}, { VERCEL_ENV: "development" }), "TEST_CLEANUP_GATE_CLOSED");
  await unchanged(c, await request(c, { expectedVersion: c.intent.version + 1 }), "TEST_CLEANUP_STALE");
  await unchanged(c, await request(c, { chargeId: "ch_test_other00000000" }), "TEST_CLEANUP_CAPTURE_NOT_PROVEN");
  await unchanged(c, await request(c, { paymentIntentId: "pi_test_other000" }), "TEST_CLEANUP_PAYMENT_MISMATCH");       // refused by the reducer binding itself
  await unchanged(c, await request(c, { capturedMinor: AMT - 1, finalTotalMinor: AMT - 1, authorizedMinor: AMT - 1 }), "TEST_CLEANUP_IDENTITY_MISMATCH");
  await unchanged(c, await request(c, { reservationId: String(Number(c.reservationId) + 1) }), "TEST_CLEANUP_RESERVATION_MISMATCH");   // reducer binding
  await unchanged(c, await request(c, { listingId: 603566 }), "TEST_CLEANUP_LISTING_NOT_ALLOWED");
  await unchanged(c, await request(c, { reservationId: "70636076" }), "TEST_CLEANUP_RESERVATION_PROTECTED");
  { const d = await capturedUSD(); const r0 = await F.reserved(db.app, { listingId: LIST, currency: "USD", from: "2029-08-01", to: "2029-08-03" }); // a reservation_confirmed intent: wrong state
    const r = await request({ ...r0, chargeId: "ch_test_notcaptured00", intent: await loadIntent(db.app, r0.id) }, { capturedMinor: AMT });
    assert.deepEqual([r.ok, r.error], [false, "ILLEGAL_TRANSITION"], JSON.stringify(r)); assert.equal((await loadIntent(db.app, r0.id)).status, "reservation_confirmed"); void d; }   // not routed from reservation_confirmed
  { const d = await capturedUSD(); // SYNTHETIC (owner, committed shape): the recording row was handed to a sender (in_flight / attempts 1 / dispatched): NOT pristine → refused, nothing retired
    const o = await db.owner.connect();
    try { await o.query("BEGIN"); await o.query("ALTER TABLE booking.external_operations DISABLE TRIGGER USER");
      await o.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'w-rec', lease_until = now() + interval '1 min' WHERE intent_id = $1 AND op_type = $2", [d.id, RECORD]);
      await o.query("ALTER TABLE booking.external_operations ENABLE TRIGGER USER"); await o.query("COMMIT"); } catch (e) { await o.query("ROLLBACK").catch(() => {}); throw e; } finally { o.release(); }
    const r = await request(d); assert.deepEqual([r.ok, r.error], [false, "TEST_CLEANUP_RECORDING_NOT_PRISTINE"], JSON.stringify(r));
    assert.deepEqual((await rows(d.id, RECORD)).map((o) => o.state), ["in_flight"]); assert.equal((await rows(d.id, REFUND)).length, 0); assert.equal((await loadIntent(db.app, d.id)).status, "payment_captured"); }
  { const d = await capturedUSD(); // an open case
    F.ok(await applyEvent(db.app, d.id, { type: "ESCALATE", code: "MANUAL_ESCALATION" }, { now: F.at(9) }));
    const r = await request(d, { expectedVersion: (await loadIntent(db.app, d.id)).version }); assert.deepEqual([r.ok, r.error], [false, "ILLEGAL_TRANSITION"]); }   // reconciliation_required: not routed
  { const d = await capturedUSD(); // SYNTHETIC: the intent is marked live (owner, rolled back) → the 0019 guard refuses the transition itself
    const o = await db.owner.connect();
    try { await o.query("BEGIN"); await o.query("SAVEPOINT a");
      await assert.rejects(o.query("UPDATE booking.intents SET environment = 'live', version = version + 1, updated_at = now() WHERE id = $1", [d.id]), /immutable/, "an intent's environment can never be rewritten");
      await o.query("ROLLBACK TO SAVEPOINT a"); await o.query("UPDATE booking.instance SET environment = 'live'");
      await assert.rejects(o.query("UPDATE booking.intents SET state = 'test_cleanup_pending', version = version + 1, updated_at = now() WHERE id = $1", [d.id]), /TEST_CLEANUP_NOT_TEST/);
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } }
});

test("Q3 REAL legs: claim HELD after the cancel leg alone and after the refund leg alone (either order); released ONLY when BOTH exact proven legs land → cancelled (reason TEST_CLEANUP_REQUESTED, publicStatus not_completed_refunded); capturedMinor immutable; refund recorded separately (payment_refunds succeeded + ledger refund_succeeded); no notification queued", async () => {
  for (const [n, first, second] of [[5, cancelLeg, (c, t) => refundLeg(c, t).then((x) => x.r)], [6, (c, t) => refundLeg(c, t).then((x) => x.r), cancelLeg]]) {
    const c = await capturedUSD(db.app, n);
    F.ok(await request(c));
    const led0 = await ledger(c.id);
    F.ok(await first(c, 30), `order ${n}: first leg`);
    const i1 = await loadIntent(db.app, c.id);
    assert.equal(i1.status, "test_cleanup_pending", `order ${n}: one leg only`); assert.equal(await held(c.id), true, `order ${n}: held after one leg`);
    assert.deepEqual(await blockers(c.id), ["STATE_NOT_RELEASABLE:test_cleanup_pending"]);
    F.ok(await second(c, 40), `order ${n}: second leg`);
    const i2 = await loadIntent(db.app, c.id);
    assert.deepEqual([i2.status, i2.reasonCode, i2.settlement, i2.payment.capturedMinor, publicStatus(i2)], ["cancelled", "TEST_CLEANUP_REQUESTED", { reservationCancelled: true, authorizationSettled: true }, AMT, "not_completed_refunded"], `order ${n}`);
    assert.equal(await held(c.id), false, `order ${n}: released after both proven legs`);
    assert.deepEqual(await blockers(c.id), [], `order ${n}`);
    const re = (await rows(c.id, REFUND))[0].result_ref;
    assert.deepEqual(await refundRecords(c.id), [{ seq: 1, idempotency_key: refundKey(c.id, 1), state: "succeeded", hostaway_state: "not_applicable", amt: String(AMT), currency: "USD", stripe_refund_id: re, reason_code: "TEST_CLEANUP", requested_by: "admin" }]);
    assert.deepEqual((await ledger(c.id)).filter((l) => !led0.some((x) => JSON.stringify(x) === JSON.stringify(l))), [{ entry: "refund_succeeded", amt: String(AMT), currency: "USD", provider: "stripe", provider_ref: re }], "exactly one new ledger fact");
    assert.ok(led0.some((l) => l.entry === "capture_succeeded" && l.amt === String(AMT)), "captured history kept");
    assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type IN ('guest.notify', 'alert.owner')", [c.id])).rows[0].n, 0);
    assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(500), intentId: c.id, opTypes: [REFUND, CANCEL, CAP, RECORD] }), null, "nothing claimable afterwards");
  }
});

test("Q4 REAL negative refund proofs NEVER settle the leg (AUTHORIZATION_NOT_VERIFIED_SETTLED), the claim stays held: missing refund read; refund read for another id / PI / charge / wrong amount / wrong currency / status pending|failed; PI read missing / before the dispatch / partially refunded; unbound REFUND_SUCCEEDED (no succeeded row / wrong id); a later non-succeeded refund read contradicts", async () => {
  const attempt = async (c, re, ev) => applyEvent(db.app, c.id, ev ?? { type: "REFUND_SUCCEEDED", id: `refund-try:${c.id}:${Math.random()}`, refundId: re, chargeId: c.chargeId, amountMinor: AMT, currency: "usd" }, { now: F.at(45), actor: "worker" });
  const stillPending = async (c, label) => { const i = await loadIntent(db.app, c.id); assert.deepEqual([i.status, i.settlement.authorizationSettled, await held(c.id)], ["test_cleanup_pending", false, true], label); };
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_q4a";
    // unbound event before any send: the guard refuses REFUND_NOT_VERIFIED
    let r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "REFUND_NOT_VERIFIED"]); await stillPending(c, "no row");
    await refundSend(c, re, 30);
    r = await attempt(c, "re_test_other"); assert.deepEqual([r.ok, r.error], [false, "REFUND_NOT_VERIFIED"], "wrong id vs the row"); await stillPending(c, "wrong id");
    r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"], "row succeeded but NO refund read"); await stillPending(c, "no read");
    await piRead(c, 31);
    r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"], "PI read alone (aggregate) is not identification"); await stillPending(c, "aggregate only");
    F.ok(await refundRead(c, re, 32, { amount: AMT - 100 })); r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"], "partial refund read"); await stillPending(c, "partial");
    F.ok(await refundRead(c, re, 33, { charge: "ch_test_other0000000" })); r = await attempt(c, re); assert.deepEqual(r.ok, false, "other charge"); await stillPending(c, "other charge");
    F.ok(await refundRead(c, re, 34, { currency: "MXN" })); r = await attempt(c, re); assert.deepEqual(r.ok, false, "other currency"); await stillPending(c, "other currency");
    F.ok(await refundRead(c, re, 35, { status: "pending" })); r = await attempt(c, re); assert.deepEqual(r.ok, false, "pending"); await stillPending(c, "pending");
    F.ok(await refundRead(c, re, 36, { status: "failed" })); r = await attempt(c, re); assert.deepEqual(r.ok, false, "failed"); await stillPending(c, "failed");
    // now a correct bound read, but the PI read is partially refunded
    F.ok(await refundRead(c, re, 37)); await piRead(c, 38, { refunded: AMT - 100 }); r = await attempt(c, re); assert.deepEqual(r.ok, false, "PI shows partial"); await stillPending(c, "PI partial");
    // a correct PI read → settles
    await piRead(c, 39); r = await attempt(c, re); assert.equal(r.ok, true, JSON.stringify(r));
    const i = await loadIntent(db.app, c.id); assert.deepEqual([i.status, i.settlement.authorizationSettled, await held(c.id)], ["test_cleanup_pending", true, true], "refund leg settled, cancel leg open, claim held");
    // a LATER non-succeeded refund read of the same id contradicts: the terminal transition is refused by the DB (CANCELLATION_NOT_VERIFIED) and the claim stays
    F.ok(await refundRead(c, re, 41, { status: "failed" }));
    const cr = await cancelLeg(c, 42); assert.deepEqual([cr.ok, cr.error], [false, "CANCELLATION_NOT_VERIFIED"], JSON.stringify(cr));
    const i3 = await loadIntent(db.app, c.id); assert.deepEqual([i3.status, await held(c.id)], ["test_cleanup_pending", true]); }
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_q4b";   // evidence observed BEFORE the dispatch never counts
    await piRead(c, 25); await refundSend(c, re, 30); F.ok(await refundRead(c, re, 31));
    const r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"]); await stillPending(c, "stale PI read"); }
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_q4c";   // the refund read is for the right id but names ANOTHER PI
    await refundSend(c, re, 30); F.ok(await refundRead(c, re, 31, { pi: "pi_test_other000" })); await piRead(c, 32);
    const r = await attempt(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"]); await stillPending(c, "other PI"); }
});

test("Q5 REAL uncertainty: a lost refund reply → outcome_unknown row + REFUND_OUTCOME_UNKNOWN (reads only, payment_refunds outcome_unknown); the row is never claimable again; a second refund row can never be created (DB unique); REFUND_FAILED → owner case, claim held; the capture history is immutable throughout", async () => {
  const c = await capturedUSD(); F.ok(await request(c)); const cap0 = await rows(c.id, CAP);
  const op = await claimNextOperation(db.app, { workerId: "w-cleanup", now: F.at(30), intentId: c.id, opTypes: [REFUND] }); assert.ok(op);
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-cleanup", now: F.at(30), outcome: { status: "outcome_unknown", errorCode: "NETWORK_ERROR" } }));
  F.ok(await applyEvent(db.app, c.id, { type: "REFUND_OUTCOME_UNKNOWN", id: `refund-unk:${c.id}`, code: "NETWORK_ERROR" }, { now: F.at(31), actor: "worker" }));
  assert.deepEqual((await rows(c.id, REFUND)).map((o) => o.state), ["outcome_unknown"]);
  assert.deepEqual((await refundRecords(c.id)).map((x) => x.state), ["outcome_unknown"]);
  assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(500), intentId: c.id, opTypes: [REFUND] }), null, "no blind resend");
  assert.equal((await rows(c.id, "stripe.retrieve_payment_intent")).some((o) => o.state === "pending"), true, "a PI read was queued");
  await assert.rejects(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'reconcile_first', 'pending', '{}', 1, 1, now(), now(), now())`, [c.id, REFUND, `refund:${c.id}:2`]), /one_refund_ever/, "a second refund row is impossible");
  assert.deepEqual([(await loadIntent(db.app, c.id)).status, await held(c.id)], ["test_cleanup_pending", true]);
  const f = await applyEvent(db.app, c.id, { type: "REFUND_FAILED", id: `refund-fail:${c.id}`, code: "REFUND_NOT_PROVEN" }, { now: F.at(60), actor: "worker" });
  F.ok(f); const i = await loadIntent(db.app, c.id);
  assert.deepEqual([i.status, i.reasonCode, await held(c.id)], ["reconciliation_required", "REFUND_NOT_PROVEN", true]);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [c.id])).rows[0].n, 1);
  assert.deepEqual(await rows(c.id, CAP), cap0, "capture row immutable"); assert.equal((await captured(c.id)).c, String(AMT));
});

test("Q6 fences: the refund row is claimable ONLY in test_cleanup_pending with the authorization leg open (REFUND_CLAIM_FENCED otherwise); the recording may be retired ONLY by the cleanup transaction (RECORDING_RETIREMENT_FENCED for any other writer / shape); the compensation worker's cancel fence admits the cleanup's cancel leg", async () => {
  const c = await capturedUSD();
  // a recording row of a payment_captured intent cannot be superseded by anyone (owner path, rolled back)
  { const o = await db.owner.connect(); try { await o.query("BEGIN");
      await assert.rejects(o.query("UPDATE booking.external_operations SET state = 'superseded' WHERE intent_id = $1 AND op_type = $2", [c.id, RECORD]), /RECORDING_RETIREMENT_FENCED/);
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } }
  F.ok(await request(c));
  // the guard itself refuses flagging the authorization leg without proof (owner, rolled back)
  { const o = await db.owner.connect(); try { await o.query("BEGIN");
      await assert.rejects(o.query("UPDATE booking.intents SET settlement_authorization_settled = true, version = version + 1, updated_at = now() WHERE id = $1", [c.id]), /AUTHORIZATION_NOT_VERIFIED_SETTLED/);
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } }
  // the refund claim fence on a pending row of a settled leg (owner synthetic: the flag forced with triggers off, rolled back)
  { const o = await db.owner.connect(); try { await o.query("BEGIN"); await o.query("ALTER TABLE booking.intents DISABLE TRIGGER USER");
      await o.query("UPDATE booking.intents SET settlement_authorization_settled = true WHERE id = $1", [c.id]);
      await assert.rejects(o.query("UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'x', lease_until = now() + interval '1 min', dispatched_at = now(), attempts = 1 WHERE intent_id = $1 AND op_type = $2", [c.id, REFUND]), /REFUND_CLAIM_FENCED/);
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } }
  // the cancel leg IS claimable in test_cleanup_pending (0009 fence extended), and succeeds through the accepted path
  F.ok(await cancelLeg(c, 30));
  assert.deepEqual([(await loadIntent(db.app, c.id)).settlement.reservationCancelled, await held(c.id)], [true, true]);
});

test("Q7 SYNTHETIC negative matrix on a REAL completed cleanup (owner, rolled back): the blockers re-appear when the refund record, the ledger entry, the refund row, the bound read or the PI read is removed or altered; the void path (authorization_settled_for) is untouched and an ordinary cancelled-after-void intent still releases exactly as before", async () => {
  const c = await capturedUSD(); F.ok(await request(c));
  const { re } = await refundLeg(c, 30); F.ok(await cancelLeg(c, 40));
  assert.deepEqual([(await loadIntent(db.app, c.id)).status, await held(c.id), await blockers(c.id)], ["cancelled", false, []]);
  const syn = async (mutate) => { const o = await db.owner.connect(); try { await o.query("BEGIN");
      for (const t of ["external_operations", "intents", "payment_refunds", "payment_ledger", "provider_evidence"]) await o.query(`ALTER TABLE booking.${t} DISABLE TRIGGER USER`);
      await mutate(o); return (await o.query("SELECT booking.claim_release_blockers($1) AS b", [c.id])).rows[0].b;
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } };
  const UNSETTLED = [`AUTHORIZATION_UNSETTLED:${c.piId}`];
  assert.deepEqual(await syn(async () => {}), [], "baseline");
  assert.deepEqual(await syn((o) => o.query("DELETE FROM booking.payment_refunds WHERE intent_id = $1", [c.id])), UNSETTLED, "no audited refund record");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.payment_refunds SET state = 'outcome_unknown' WHERE intent_id = $1", [c.id])), UNSETTLED, "record not succeeded");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.payment_refunds SET amount_minor = amount_minor - 1 WHERE intent_id = $1", [c.id])), UNSETTLED, "record partial");
  assert.deepEqual(await syn((o) => o.query("DELETE FROM booking.payment_ledger WHERE intent_id = $1 AND entry = 'refund_succeeded'", [c.id])), UNSETTLED, "no ledger entry");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.external_operations SET state = 'outcome_unknown' WHERE intent_id = $1 AND op_type = $2", [c.id, REFUND])), [...UNSETTLED, "PROVIDER_OPERATION_UNRESOLVED:stripe.refund_payment_intent:outcome_unknown"], "refund row unresolved");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.external_operations SET result_ref = 're_test_other' WHERE intent_id = $1 AND op_type = $2", [c.id, REFUND])), UNSETTLED, "row id ≠ read id");
  assert.deepEqual(await syn((o) => o.query("DELETE FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'stripe_refund'", [c.id])), UNSETTLED, "no bound refund read");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.provider_evidence SET observed = observed || '{\"amountMinor\": 1}' WHERE intent_id = $1 AND kind = 'stripe_refund'", [c.id])), UNSETTLED, "read amount ≠ captured");
  assert.deepEqual(await syn((o) => o.query("DELETE FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent'", [c.id])), UNSETTLED, "no PI read");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.provider_evidence SET observed = jsonb_set(observed, '{livemode}', 'true') WHERE intent_id = $1 AND kind = 'payment_intent'", [c.id])), UNSETTLED, "PI not TEST");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.payment_attempts SET livemode = true WHERE intent_id = $1", [c.id])), UNSETTLED, "attempt not TEST");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.intents SET environment = 'live' WHERE id = $1", [c.id])), UNSETTLED, "intent not TEST");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.instance SET environment = 'live'")), UNSETTLED, "instance not TEST");
  assert.deepEqual(await syn((o) => o.query("UPDATE booking.intents SET captured_minor = 0 WHERE id = $1", [c.id])), UNSETTLED, "a zeroed captured amount is NOT a settlement");
  assert.equal(String(re).startsWith("re_"), true);
  // the ordinary void path is unchanged: capture_failed → cancelled after cancel + void still releases (0017 precedent, P class)
  { const p = await F.reserved(db.app, { listingId: LIST, currency: "USD", from: "2029-09-01", to: "2029-09-03" });
    F.ok(await applyEvent(db.app, p.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
    await F.runOp(db.app, p.id, CANCEL, 9); await F.reservationStatus(db.app, p.id, String(p.reservationId), "cancelled", {}, 9); F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(9) }));
    assert.equal(await held(p.id), true);
    await F.runOp(db.app, p.id, "stripe.void_payment_intent", 10); F.ok(await applyEvent(db.app, p.id, { type: "VOID_SUCCEEDED" }, { now: F.at(10) }));
    assert.deepEqual([(await loadIntent(db.app, p.id)).status, await held(p.id), await blockers(p.id)], ["cancelled", false, []]); }
});

test("Q8 migration: 0019 down restores the 0018 schema exactly (constraints, indexes, functions, triggers); up re-applies identically; the replaced functions keep owner / ACL / security / volatility (body only)", async () => {
  const fnAttrs = async (c) => (await c.query(`SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.provolatile AS vol, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
      coalesce(array_to_string(p.proacl::text[], ','), '') AS acl FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      AND p.proname IN ('authorization_blockers', 'claim_release_blockers', 'intents_safety_guard', 'record_provider_evidence', 'validate_evidence', 'is_intent_state', 'void_cancel_claim_fence') ORDER BY 1`)).rows;
  const objects = async (c) => (await c.query(`SELECT 'con|' || conrelid::regclass::text || '|' || pg_get_constraintdef(oid) AS o FROM pg_constraint WHERE connamespace = 'booking'::regnamespace AND contype = 'c'
      UNION ALL SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexrelid::regclass::text || '|' || pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'booking.%'
      UNION ALL SELECT 'tbl|' || c.relname || '|' || coalesce(array_to_string(c.relacl, ','), '') FROM pg_class c WHERE c.relnamespace = 'booking'::regnamespace ORDER BY 1`)).rows.map((x) => x.o);
  const fresh = await startPostgres(); const c18 = new pg.Client({ connectionString: fresh.adminUrl }); await c18.connect();
  let base18, base18Objs;
  try { await migrateUp(c18, { env: "test", to: 18 }); base18 = await fnAttrs(c18); base18Objs = await objects(c18); } finally { await c18.end(); fresh.stop(); }
  // a second fresh cluster for the round trip (the shared db already holds 0019 rows, which the down refuses by design)
  const rt = await startPostgres(); const c = new pg.Client({ connectionString: rt.adminUrl }); await c.connect();
  try {
    await migrateUp(c, { env: "test" });
    const at19 = await fnAttrs(c); const at19Objs = await objects(c);
    assert.deepEqual(at19.map((f) => ({ ...f })), base18.map((f) => ({ ...f })), "owner, ACL, SECURITY DEFINER, volatility, search_path, signature unchanged for every replaced function");
    assert.deepEqual(await migrateDown(c, { env: "test", to: 18 }), [19]);
    assert.deepEqual(await objects(c), base18Objs, "down = 0018 schema exactly");
    assert.deepEqual(await migrateUp(c, { env: "test" }), [19]);
    assert.deepEqual(await objects(c), at19Objs, "up re-applies identically");
    const added = at19Objs.filter((o) => !base18Objs.includes(o)).map((o) => o.split("|").slice(0, 2).join("|"));
    for (const n of ["fn|booking.test_refund_settled_for(uuid,text)", "fn|booking.test_refund_ledgered(uuid,text)", "fn|booking.refund_claim_fence()", "fn|booking.recording_retirement_fence()",
      "fn|booking.test_refund_pi_observation_ok(jsonb,uuid,text,text,bigint,text)", "fn|booking.test_cleanup_cancel_bound()",
      "idx|booking.external_operations_one_refund_ever", "trg|booking.external_operations", "fn|booking.authorization_blockers(uuid)", "fn|booking.intents_safety_guard()"]) assert.ok(added.includes(n), n);
  } finally { await c.end(); rt.stop(); }
});

// =============================================================================================
// ROOT review 5879309344 (PR67 @ 1ee73829) — exact reproductions through the accepted APIs (RED on 1ee73829; GREEN here)
const settled = (c) => db.app.query("SELECT booking.test_refund_settled_for($1, $2) AS ok", [c.id, c.piId]).then((r) => r.rows[0].ok);
const tryRefundOk = (c, re, t = 45) => applyEvent(db.app, c.id, { type: "REFUND_SUCCEEDED", id: `refund-try:${c.id}:${t}:${Math.random()}`, refundId: re, chargeId: c.chargeId, amountMinor: AMT, currency: "usd" }, { now: F.at(t), actor: "worker" });

test("RF1 (F1) the LATEST bound-refund observation decides: valid full read then a NEWER succeeded read with another amount / PI / charge / currency → NOT settled (predicate false, REFUND_SUCCEEDED refused, claim held); equal-timestamp observations are a refused tie; a newer VALID read restores; the terminal is refused while the latest contradicts", async () => {
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_rf1a";
    await refundSend(c, re, 30); F.ok(await refundRead(c, re, 31)); await piRead(c, 31);
    assert.equal(await settled(c), true, "baseline: one valid read settles");
    F.ok(await refundRead(c, re, 32, { amount: AMT - 1 }));                                   // newer, status still succeeded, partial amount
    assert.equal(await settled(c), false, "RED on 1ee73829: the newer contradictory succeeded read was ignored");
    const r = await tryRefundOk(c, re); assert.deepEqual([r.ok, r.error], [false, "AUTHORIZATION_NOT_VERIFIED_SETTLED"]);
    assert.deepEqual([(await loadIntent(db.app, c.id)).settlement.authorizationSettled, await held(c.id)], [false, true]);
    F.ok(await refundRead(c, re, 33));                                                       // a newer VALID read restores
    assert.equal(await settled(c), true);
    for (const [t, o] of [[34, { pi: "pi_test_other000" }], [35, { charge: "ch_test_other0000000" }], [36, { currency: "MXN" }]]) {
      F.ok(await refundRead(c, re, t, o)); assert.equal(await settled(c), false, JSON.stringify(o));
    }
    F.ok(await refundRead(c, re, 40)); assert.equal(await settled(c), true); }
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_rf1b";       // tie: two observations at the same instant (one valid, one partial)
    await refundSend(c, re, 30); await piRead(c, 31); F.ok(await refundRead(c, re, 32)); F.ok(await refundRead(c, re, 32, { amount: AMT - 1 }));
    assert.equal(await settled(c), false, "a tie never picks the convenient row");
    const r = await tryRefundOk(c, re); assert.equal(r.ok, false); assert.equal(await held(c.id), true); }
  { const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_rf1c";       // full event / terminal / claim path: settle, then a newer contradictory read, then the cancel leg
    await refundSend(c, re, 30); F.ok(await refundRead(c, re, 31)); await piRead(c, 31);
    F.ok(await tryRefundOk(c, re, 32)); assert.equal((await loadIntent(db.app, c.id)).settlement.authorizationSettled, true);
    F.ok(await refundRead(c, re, 33, { amount: AMT - 1 }));
    const cr = await cancelLeg(c, 34); assert.deepEqual([cr.ok, cr.error], [false, "CANCELLATION_NOT_VERIFIED"], JSON.stringify(cr));
    assert.deepEqual([(await loadIntent(db.app, c.id)).status, await held(c.id)], ["test_cleanup_pending", true]);
    F.ok(await refundRead(c, re, 35));                                                       // only after the latest read is valid again (the cancel row + cancelled read already exist)
    F.ok(await applyEvent(db.app, c.id, { type: "RESERVATION_CANCELLED", id: `cancel-ok2:${c.id}` }, { now: F.at(36) }));
    assert.deepEqual([(await loadIntent(db.app, c.id)).status, await held(c.id)], ["cancelled", false]); }
});

test("RF2 (F2) the PI observation must be a COHERENT typed v3 captured-and-fully-refunded proof: each ROOT field altered alone → NOT settled (charge.paymentIntent other PI; EUR currencies; missing proofVersion; accountVerified false; charge.paid false), plus object / status / metadata / captureMethod / amounts / types / tie", async () => {
  const c = await capturedUSD(); F.ok(await request(c)); const re = "re_test_rf2";
  await refundSend(c, re, 30); F.ok(await refundRead(c, re, 31));
  let t = 32;
  const check = async (label, top, expect) => {
    t += 1; await piRead(c, t, { top }); assert.equal(await settled(c), expect, label);
  };
  await check("valid v3", {}, true);
  const base = piObserved(c); const ch = base.latestCharge;
  const cases = [
    ["charge.paymentIntent = another PI", { latestCharge: { ...ch, paymentIntent: "pi_test_other000" } }],
    ["EUR on a USD intent (PI + charge)", { currency: "EUR", latestCharge: { ...ch, currency: "EUR" } }],
    ["missing proofVersion", { proofVersion: undefined }],
    ["accountVerified false", { accountVerified: false }],
    ["charge.paid false", { latestCharge: { ...ch, paid: false } }],
    ["object not payment_intent", { object: "charge" }],
    ["PI id other", { paymentIntentId: "pi_test_other000" }],
    ["metadata intent other", { metadataIntentId: "00000000-0000-4000-8000-000000000000" }],
    ["metadata attempt other", { metadataAttemptId: "00000000-0000-4000-8000-000000000000" }],
    ["captureMethod automatic", { captureMethod: "automatic" }],
    ["amountReceived short", { amountReceivedMinor: AMT - 1 }],
    ["amountCapturable non-zero", { amountCapturableMinor: 1 }],
    ["livemode as string", { livemode: "false" }],
    ["accountVerified as string", { accountVerified: "true" }],
    ["charge.captured false", { latestCharge: { ...ch, captured: false } }],
    ["charge.amountRefunded partial", { latestCharge: { ...ch, amountRefundedMinor: AMT - 100 } }],
    ["charge.amountCaptured as string", { latestCharge: { ...ch, amountCapturedMinor: String(AMT) } }],
    ["charge.livemode true", { latestCharge: { ...ch, livemode: true } }],
    ["charge.refunded false", { latestCharge: { ...ch, refunded: false } }],
    ["charge id other", { latestCharge: { ...ch, id: "ch_test_other0000000" } }],
    ["latestCharge missing", { latestCharge: null }]
  ];
  for (const [label, top] of cases) {
    const o = { ...top }; if ("proofVersion" in o && o.proofVersion === undefined) delete o.proofVersion;
    t += 1;
    const observed = { ...piObserved(c), ...o }; if (top.proofVersion === undefined && "proofVersion" in top) delete observed.proofVersion;
    const id = await F.completedRead(db.app, c.id, "stripe.retrieve_payment_intent", c.piId, F.at(t));
    F.ok(await recordProviderEvidence(db.app, { readOpId: id, kind: "payment_intent", externalRef: c.piId, status: "succeeded", observed }), label);
    assert.equal(await settled(c), false, `RED on 1ee73829 for the five ROOT fields: ${label}`);
    const r = await tryRefundOk(c, re, 100 + t); assert.equal(r.ok, false, label);
  }
  assert.equal(await held(c.id), true);
  // a newer valid observation settles again; two PI observations at the same instant are a refused tie
  await check("valid again", {}, true);
  t += 1; await piRead(c, t); await piRead(c, t, { refunded: AMT - 1 }); assert.equal(await settled(c), false, "PI tie refused");
});

test("RF3 (F3) ONE cancel only: cancel attempt 1 → outcome_unknown → found_active read at dispatch + 2 min → settle failed_definite → RECONCILED_RESERVATION_STILL_ACTIVE escalates to an owner case with NO second cancel (default and permissive maxCancelAttempts; same step and a second session); the DB refuses a second cancel row / an attempt-2 claim while test_cleanup_pending; capture_failed keeps its bounded retry", async () => {
  const stillActive = async (c, cfg) => applyEvent(db.app, c.id, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, { now: F.at(40), config: cfg });
  const chain = async (c) => {
    const op = await claimNextOperation(db.app, { workerId: "w-cleanup", now: F.at(30), intentId: c.id, opTypes: [CANCEL] }); assert.ok(op, "cancel attempt 1 claimable");
    F.ok(await completeOperation(db.app, op.id, { workerId: "w-cleanup", now: F.at(30), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
    F.ok(await applyEvent(db.app, c.id, { type: "RESERVATION_CANCEL_OUTCOME_UNKNOWN", id: `cancel-unk:${c.id}`, code: "TIMEOUT" }, { now: F.at(31) }));
    const ev = await F.reservationStatus(db.app, c.id, String(c.reservationId), "found_active", { listingId: LIST, from: c.stay.from, to: c.stay.to, totalMinor: AMT, currency: "USD" }, 33);
    assert.deepEqual(F.ok(await settleOperationFromEvidence(db.app, op.id, ev)).state, "failed_definite");
    return op;
  };
  for (const cfg of [{}, { maxCancelAttempts: 10 }]) {
    const c = await capturedUSD(); F.ok(await request(c)); await chain(c);
    const r = await stillActive(c, cfg);
    F.ok(r); const i = await loadIntent(db.app, c.id);
    assert.deepEqual([i.status, i.reasonCode, i.counters.cancelAttempts], ["reconciliation_required", "RESERVATION_STILL_ACTIVE_AFTER_CANCEL", 1], `RED on 1ee73829 (${JSON.stringify(cfg)}): a second cancel was queued`);
    assert.deepEqual((await rows(c.id, CANCEL)).map((o) => [o.state, o.payload.attempt]), [["failed_definite", 1]], "exactly ONE cancel row, ever");
    assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [c.id])).rows[0].n, 1);
    assert.equal(await held(c.id), true);
    // second session: nothing claimable, the event is not routed from reconciliation_required
    assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(500), intentId: c.id, opTypes: [CANCEL, REFUND] }), null);
    assert.equal((await stillActive(c, cfg)).ok, false);
  }
  { // DB layer: a second cancel row cannot be created while test_cleanup_pending; an attempt-2 row (owner synthetic, triggers off on insert) cannot be claimed
    const c = await capturedUSD(); F.ok(await request(c));
    await assert.rejects(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, next_attempt_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, 'reconcile_first', 'pending', $4, 1, 1, now(), now(), now())`, [c.id, CANCEL, `hcancel:${c.id}:${c.reservationId}:2`, { reservationId: String(c.reservationId), cancelledBy: "host", attempt: 2 }]), /CANCEL_BOUND_FENCED/);
    const o = await db.owner.connect();
    try { await o.query("BEGIN"); await o.query("ALTER TABLE booking.external_operations DISABLE TRIGGER USER");
      await o.query("UPDATE booking.external_operations SET payload = payload || '{\"attempt\": 2}' WHERE intent_id = $1 AND op_type = $2", [c.id, CANCEL]);
      await o.query("ALTER TABLE booking.external_operations ENABLE TRIGGER USER");
      await assert.rejects(o.query("UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'x', lease_until = now() + interval '1 min', dispatched_at = now(), attempts = 1 WHERE intent_id = $1 AND op_type = $2", [c.id, CANCEL]), /CANCEL_CLAIM_FENCED/);
    } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); } }
  { // capture_failed (void path) keeps its bounded retry: still-active → attempt 2 queued
    const p = await F.reserved(db.app, { listingId: LIST, currency: "USD", from: "2029-10-01", to: "2029-10-03" });
    F.ok(await applyEvent(db.app, p.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
    const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: p.id, opTypes: [CANCEL] }); assert.ok(op);
    F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
    F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_CANCEL_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(10) }));
    const ev = await F.reservationStatus(db.app, p.id, String(p.reservationId), "found_active", { listingId: LIST, from: "2029-10-01", to: "2029-10-03", totalMinor: AMT, currency: "USD" }, 12);
    assert.deepEqual(F.ok(await settleOperationFromEvidence(db.app, op.id, ev)).state, "failed_definite");
    F.ok(await applyEvent(db.app, p.id, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, { now: F.at(13) }));
    assert.deepEqual([(await loadIntent(db.app, p.id)).status, (await loadIntent(db.app, p.id)).counters.cancelAttempts, (await rows(p.id, CANCEL)).length], ["capture_failed", 2, 2], "unchanged"); }
});
