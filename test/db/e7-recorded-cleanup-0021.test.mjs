// 0021 (LOCAL MIGRATION CANDIDATE, ROOT design pass 5884066227) — TEST cleanup of a RECORDED TEST booking: the foundation (schema, reducer,
// codec, repo mappings, the recorded request module, the typed SQL mirror proof, the audited suppression) WITHOUT any worker / transport /
// runner. Throwaway local PostgreSQL only.
//   REAL      = reached through the accepted repo / operations / evidence API as mv_booking_app (applyEvent, claimNextOperation,
//               completeOperation, requestRead, recordProviderEvidence, completeOfflineRefundWithEvidence, requestRecordedTestCleanup).
//   SYNTHETIC = owner-written rows (notification claim / render / latch surrogates; a bypassed flag) ONLY to evaluate the fences on shapes the
//               runnable path cannot produce here. Labelled where used.
// Mock LIST / Refund / PaymentIntent observations are FIXTURE data shaped like the accepted proofs; they are NOT provider proof.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startMigratedDatabase, startPostgres } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers, createIntentRecord, collectGuestDetails, beginPayStep, recordCheckoutSession, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence, completeRecordingWithEvidence, completeOfflineRefundWithEvidence } from "../../lib/booking-db/operations.js";
import { requestTestCleanup } from "../../lib/booking-db/test-cleanup.js";
import { requestRecordedTestCleanup, bindRecordedCleanupExpectation, TEST_CLEANUP_RECORDED_EXPECTATION_KEYS } from "../../lib/booking-db/test-cleanup-recorded.js";
import { rowToIntent, intentToRow, MUTABLE_COLUMNS, MIRROR_COLUMN, hasMirrorLeg } from "../../lib/booking-db/codec.js";
import { migrateUp, migrateDown } from "../../db/lib/migrate.js";
import { transition, EVENTS, STATES, TERMINAL_STATES, allowedEvents, refundKey, offlineRefundKey, testCleanupRecordedEventId, createIntent } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const CAP = "stripe.capture_payment_intent", REFUND = "stripe.refund_payment_intent", CANCEL = "hostaway.cancel_reservation", RECORD = "hostaway.record_offline_charge",
  MIRROR = "hostaway.refund_offline_charge", NOTIFY = "guest.notify", LISTOP = "hostaway.list_offline_charges";
const LIST = 606998; const AMT = 576000; const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_CLEANUP: "enabled" });
const held = async (id, pool = db.app) => (await F.count(pool, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])) === 1;
const rows = async (id, type, pool = db.app) => (await pool.query(`SELECT id, state, attempts, dispatched_at, lease_worker_id, lease_until, result_ref, payload, settled_evidence_id, idempotency_key
  FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id`, [id, type])).rows;
const ledger = async (id, pool = db.app) => (await pool.query("SELECT entry, amount_minor::text AS amt, currency, provider, provider_ref FROM booking.payment_ledger WHERE intent_id = $1 ORDER BY id", [id])).rows;
const intentRow = async (id, pool = db.app) => (await pool.query("SELECT state, version, reason_code, offline_charge_id, settlement_reservation_cancelled AS rc, settlement_authorization_settled AS a, settlement_recording_mirrored AS m FROM booking.intents WHERE id = $1", [id])).rows[0];
const suppressions = async (id, pool = db.app) => (await pool.query("SELECT operation_id, intent_version, reason, suppressed_by FROM booking.notification_suppressions WHERE intent_id = $1", [id])).rows;
const settledFor = async (id, pool = db.app) => (await pool.query("SELECT booking.offline_refund_settled_for($1) AS ok", [id])).rows[0].ok;
const endOk = async (id, pool = db.app) => (await pool.query("SELECT booking.recorded_state_cleanup_ok($1) AS ok", [id])).rows[0].ok;
const refusal = (p, re) => assert.rejects(p, re);

// ---- REAL fixtures ----
/** a CAPTURED TEST payment on 606998 / USD (0019 pattern: the capture result is a Stripe CHARGE id) */
let stayN = 0;
/** F.reserved with a caller-chosen guest (the 0016 v1 recipient scope is `.invalid`; the shared fixture guest is out of scope) — same accepted steps */
async function reservedWithGuest(pool, stay, guest) {
  const intent = await createIntentRecord(pool, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: F.at(0), guests: 2, ...stay });
  const id = intent.id;
  F.ok(await applyEvent(pool, id, { type: "PRICE_CONFIRMED", price: F.priceFor(stay) }, { now: F.at(0), actor: "guest" }), "price");
  F.ok(await collectGuestDetails(pool, id, guest, { now: F.at(1), termsVersion: "terms-2026-10" }), "details");
  const b = F.ok(await beginPayStep(pool, id, { now: F.at(2) }), "pay");
  const sessionId = `cs_test_${id.slice(0, 8)}`;
  const cs = await claimNextOperation(pool, { workerId: "w-pay", now: F.at(2), intentId: id, opTypes: ["stripe.create_checkout_session"] });
  F.ok(await completeOperation(pool, cs.id, { workerId: "w-pay", now: F.at(2), outcome: { status: "succeeded", resultRef: sessionId } }), "cs op");
  F.ok(await recordCheckoutSession(pool, id, b.attempt.id, { sessionId, expiresAt: F.at(32), now: F.at(2) }), "session");
  const piId = `pi_test_${id.slice(0, 8)}`;
  F.ok(await applyEvent(pool, id, F.authEvent(sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }), "auth");
  F.ok(await applyEvent(pool, id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }), "start");
  F.ok(await applyEvent(pool, id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }), "dispatch");
  const rid = F.nextReservationId();
  const cr = await F.claimOp(pool, id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(pool, id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(7) });
  F.ok(await completeOperation(pool, cr.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }), "create op");
  F.ok(await applyEvent(pool, id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(7), actor: "worker" }), "reserved");
  return { id, attemptId: b.attempt.id, sessionId, piId, reservationId: rid };
}
async function capturedUSD(pool = db.app, { guest = null } = {}) {
  stayN += 1;
  const stay = { listingId: LIST, currency: "USD", from: F.addDays("2027-06-01", 3 * stayN), to: F.addDays("2027-06-01", 3 * stayN + 2) };
  const r = guest ? await reservedWithGuest(pool, stay, guest) : await F.reserved(pool, stay);
  const stripeChargeId = `ch_test_${r.id.replace(/-/g, "").slice(0, 16)}`;
  const op = await F.claimOp(pool, r.id, CAP, F.at(8));
  F.ok(await completeOperation(pool, op.id, { workerId: "w1", now: F.at(8), outcome: { status: "succeeded", resultRef: stripeChargeId } }), "capture op");
  F.ok(await applyEvent(pool, r.id, { type: "CAPTURE_SUCCEEDED", id: `evt_cap_${r.piId}`, amountMinor: AMT, currency: "usd" }, { now: F.at(8), actor: "webhook" }), "capture");
  return { ...r, stripeChargeId, stay };
}
const origObserved = (c, o = {}) => F.recordingObserved({ id: c.id, reservationId: c.reservationId, listingId: LIST }, c.offlineChargeId, { currency: "USD", ...o });
/** a RECORDED (confirmed) TEST booking: the ONE recording claimed (healthy preflight), proven by a confirming LIST read, completed through the
 *  0010 function, then OFFLINE_CHARGE_RECORDED (queues the ONE pristine guest.notify row) — F.confirmed, on USD */
async function recordedUSD(pool = db.app, opts = {}) {
  const c = await capturedUSD(pool, opts);
  const offlineChargeId = String(F.nextReservationId() + 500000);
  const cc = { ...c, offlineChargeId };
  const { op, t } = await F.claimRecording(pool, c, Date.now(), "w1");
  const { version } = (await pool.query("SELECT version FROM booking.intents WHERE id = $1", [c.id])).rows[0];
  const ev = await F.chargeListEvidence(pool, { id: c.id, reservationId: c.reservationId }, origObserved(cc), t + 1);
  F.ok(await completeRecordingWithEvidence(pool, op.id, { workerId: "w1", evidenceId: ev, resultRef: offlineChargeId, expectedVersion: version }), "recording (linked proof)");
  await pool.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [c.id]);
  F.ok(await applyEvent(pool, c.id, { type: "OFFLINE_CHARGE_RECORDED", chargeId: offlineChargeId }, { now: t + 2, actor: "worker" }), "confirmed");
  const intent = await loadIntent(pool, c.id);
  assert.equal(intent.status, "confirmed"); assert.equal(intent.offlineChargeId, offlineChargeId);
  const notify = (await rows(c.id, NOTIFY, pool))[0];
  assert.deepEqual([notify.state, notify.attempts, notify.payload], ["pending", 0, { template: "booking_confirmed" }], "ONE pristine notification");
  return { ...cc, intent, recordingOpId: op.id, recordingEvidenceId: ev, notifyOpId: notify.id };
}
async function expectationFor(c, over = {}, pool = db.app) {
  const i = await loadIntent(pool, c.id);
  return Object.freeze({ approvalRef: "SYNTHETIC-recorded-cleanup", attemptId: c.attemptId, authorizedMinor: i.payment.amountMinor, capturedMinor: i.payment.capturedMinor,
    currency: i.price.currency, expectedVersion: i.version, finalTotalMinor: i.price.finalTotalMinor, from: i.from, guests: i.guests, intentId: c.id, listingId: i.listingId,
    offlineChargeId: c.offlineChargeId, paymentIntentId: c.piId, planHash: "0".repeat(64), reservationId: String(c.reservationId), sessionId: c.sessionId,
    stripeChargeId: c.stripeChargeId, to: i.to, ...over });
}
const request = (c, over = {}, env = ENV, pool = db.app) => expectationFor(c, over, pool).then((operator) => requestRecordedTestCleanup(pool, c.id, { now: F.at(20), env, operator }));

// ---- REAL legs (0019 helpers) ----
const piObserved = (c, o = {}) => ({ proofVersion: "pi-proof-v3", object: "payment_intent", paymentIntentId: c.piId, accountVerified: true, livemode: false, metadataIntentId: c.id,
  metadataAttemptId: c.attemptId, captureMethod: "manual", status: "succeeded", amountMinor: AMT, amountReceivedMinor: AMT, amountCapturableMinor: 0, currency: "USD",
  latestCharge: { object: "charge", id: c.stripeChargeId, paymentIntent: c.piId, status: "succeeded", captured: true, amountMinor: AMT, amountCapturedMinor: AMT, amountRefundedMinor: o.refundedMinor ?? AMT,
    currency: "USD", livemode: false, paid: true, captureBefore: null }, ...o });
const refundObserved = (c, re, status = "succeeded") => ({ refundId: re, paymentIntentId: c.piId, chargeId: c.stripeChargeId, amountMinor: AMT, currency: "USD", status, created: Math.floor(F.at(22) / 1000) });
async function piRead(c, t, pool = db.app, o = {}) { const id = await F.completedRead(pool, c.id, "stripe.retrieve_payment_intent", c.piId, F.at(t)); return F.readEvidenceOf(pool, id, "payment_intent", c.piId, "succeeded", piObserved(c, o)); }
/** a NEW bound Stripe refund read through the accepted APIs (requestRead → claim → complete → recordProviderEvidence), observed at `atMs` */
async function refundRead(c, re, status, atMs = Date.now(), pool = db.app) {
  const rid = await requestRead(pool, c.id, "stripe.retrieve_refund", re, { now: atMs });
  assert.ok(await claimNextOperation(pool, { workerId: "w-read", now: atMs, opId: rid }), "refund read claimable");
  F.ok(await completeOperation(pool, rid, { workerId: "w-read", now: atMs, outcome: { status: "succeeded" } }), "refund read");
  return F.ok(await recordProviderEvidence(pool, { readOpId: rid, kind: "stripe_refund", externalRef: re, status, observed: refundObserved(c, re, status) }), "refund evidence").id;
}
const stripeSettled = async (c, pool = db.app) => (await pool.query("SELECT booking.test_refund_settled_for($1, $2) AS ok", [c.id, c.piId])).rows[0].ok;
const legsUnsettled = async (c, pool = db.app) => (await pool.query("SELECT booking.recorded_cleanup_legs_unsettled($1) AS r", [c.id])).rows[0].r;
async function refundLeg(c, t, pool = db.app) {
  const re = `re_test_${c.id.replace(/-/g, "").slice(0, 12)}`;
  const op = await claimNextOperation(pool, { workerId: "w-cleanup", now: F.at(t), intentId: c.id, opTypes: [REFUND] });
  assert.ok(op, "refund row claimable");
  F.ok(await completeOperation(pool, op.id, { workerId: "w-cleanup", now: F.at(t), outcome: { status: "succeeded", resultRef: re } }), "refund op");
  const rid = await requestRead(pool, c.id, "stripe.retrieve_refund", re, { now: F.at(t + 1) });
  assert.ok(await claimNextOperation(pool, { workerId: "w-read", now: F.at(t + 1), opId: rid }), "refund read claimable");
  F.ok(await completeOperation(pool, rid, { workerId: "w-read", now: F.at(t + 1), outcome: { status: "succeeded" } }), "refund read");
  F.ok(await recordProviderEvidence(pool, { readOpId: rid, kind: "stripe_refund", externalRef: re, status: "succeeded", observed: refundObserved(c, re) }), "refund evidence");
  await piRead(c, t + 1, pool);
  c.re = re;
  return { re, r: await applyEvent(pool, c.id, { type: "REFUND_SUCCEEDED", id: `refund-ok:${c.id}`, refundId: re, chargeId: c.stripeChargeId, amountMinor: AMT, currency: "usd" }, { now: F.at(t + 2), actor: "worker", workerId: "w-cleanup" }) };
}
/** the cancelled reservation read is observed at REAL time: the recording's preflight identity read (found_active) was observed at real time,
 *  and the release blockers judge the LATEST reservation observation */
const nowMin = () => (Date.now() - F.T0) / F.MIN;
async function cancelLeg(c, _t, pool = db.app) {
  const m = nowMin();
  await F.runOp(pool, c.id, CANCEL, m, { status: "succeeded" }, "w-cleanup");
  await F.reservationStatus(pool, c.id, String(c.reservationId), "cancelled", {}, m);
  return applyEvent(pool, c.id, { type: "RESERVATION_CANCELLED", id: `cancel-ok:${c.id}` }, { now: F.at(m) });
}
/** request + both proven legs (cancel first unless told otherwise) → test_cleanup_pending with the ONE pristine mirror row */
async function bothLegs(c, { refundFirst = false } = {}, pool = db.app) {
  F.ok(await request(c), "recorded request");
  if (refundFirst) { F.ok((await refundLeg(c, 24, pool)).r, "refund leg"); F.ok(await cancelLeg(c, 28, pool), "cancel leg"); }
  else { F.ok(await cancelLeg(c, 24, pool), "cancel leg"); F.ok((await refundLeg(c, 28, pool)).r, "refund leg"); }
  const m = await rows(c.id, MIRROR, pool);
  assert.equal(m.length, 1, "exactly ONE mirror row after both legs");
  return { ...c, mirrorOpId: m[0].id };
}
// ---- the mirror: claim + typed LIST proof (FIXTURE) + completion ----
const refundIdOf = (c) => String(Number(c.offlineChargeId) + 7);
const mirrorObserved = (c, refundId = refundIdOf(c), o = {}, row = {}, link = {}) => ({ ...origObserved(c),
  mirrorMarker: `mvochr1-${c.id}`, linkedRefundCount: 1, matchingRefundCount: 1, matchingRefundIds: [refundId],
  refundRow: { id: refundId, type: "refund", status: "succeeded", paymentProvider: "offline", amountMinor: -AMT, currency: "USD", reservationId: String(c.reservationId),
    listingMapId: LIST, title: `maraVilla refund mvochr1-${c.id}`, refundInfo: { id: String(Number(refundId) + 1000), chargeId: refundId, refundedChargeId: c.offlineChargeId, ...link }, ...row },
  ...o });
async function listEvidence(c, observed, t = Date.now(), pool = db.app) {
  const readId = await F.completedRead(pool, c.id, LISTOP, c.reservationId, t);
  return F.readEvidenceOf(pool, readId, "hostaway_offline_charges", c.reservationId, "listed", observed);
}
async function claimMirror(c, now = Date.now(), worker = "w-mirror", pool = db.app) {
  await pool.query("UPDATE booking.intent_work SET work_worker_id = $2, work_lease_until = $3 WHERE intent_id = $1", [c.id, worker, new Date(now + 10 * F.MIN)]);
  const op = await claimNextOperation(pool, { workerId: worker, now, intentId: c.id, opTypes: [MIRROR], leaseMs: 10 * F.MIN });
  assert.ok(op, "mirror row claimable");
  await new Promise((r) => setTimeout(r, 15));                                             // confirming reads are observed strictly after the send
  return op;
}
async function completeMirror(c, { observed, at = Date.now(), worker = "w-mirror", refundId = refundIdOf(c) } = {}, pool = db.app) {
  const ev = await listEvidence(c, observed ?? mirrorObserved(c, refundId), at, pool);
  const { version } = (await pool.query("SELECT version FROM booking.intents WHERE id = $1", [c.id])).rows[0];
  return { ev, r: await completeOfflineRefundWithEvidence(pool, c.mirrorOpId, { workerId: worker, evidenceId: ev, resultRef: refundId, expectedVersion: version }) };
}
const terminal = (c, refundId = refundIdOf(c), pool = db.app) => applyEvent(pool, c.id, { type: "OFFLINE_CHARGE_REFUND_RECORDED", id: `mirror-ok:${c.id}`, offlineChargeId: c.offlineChargeId,
  offlineRefundId: refundId, amountMinor: AMT, currency: "usd" }, { now: Date.now(), actor: "worker", workerId: "w-mirror" });
/** SYNTHETIC: owner writes with triggers bypassed, COMMITTED (the runnable path cannot produce these shapes here); returns an undo */
async function synthetic(sql, params) {
  const c = await db.owner.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica"); await c.query(sql, params); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

// =============================================================================================
test("R0 RED (fresh cluster at 0020, the UNCHANGED e7-test schema): no third leg, no mirror op type, no suppression API, no proof predicate; confirmed is a DB terminal state — the recorded entry is not expressible (the 5a094b16 reducer / pristine request RED is recorded in the PR evidence)", async () => {
  const fresh = await startPostgres(); const admin = new pg.Client({ connectionString: fresh.adminUrl }); await admin.connect();
  try {
    assert.equal((await migrateUp(admin, { env: "test", to: 20 })).at(-1), 20);
    await refusal(admin.query("SELECT settlement_recording_mirrored FROM booking.intents LIMIT 0"), /does not exist/);
    await refusal(admin.query("SELECT booking.suppress_guest_notification('00000000-0000-4000-8000-000000000000', 'red')"), /does not exist/);
    await refusal(admin.query("SELECT booking.offline_refund_settled_for('00000000-0000-4000-8000-000000000000')"), /does not exist/);
    await refusal(admin.query("SELECT booking.recorded_state_cleanup_ok('00000000-0000-4000-8000-000000000000')"), /does not exist/);
    await refusal(admin.query("SELECT booking.complete_offline_refund_with_evidence('00000000-0000-4000-8000-000000000000', 'w', '00000000-0000-4000-8000-000000000000', '1', 1)"), /does not exist/);
    await refusal(admin.query("SELECT 1 FROM booking.notification_suppressions"), /does not exist/);
    const opCheck = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'external_operations_op_type_check'")).rows[0].d;
    assert.ok(!opCheck.includes("hostaway.refund_offline_charge"), "no mirror op type at 0020");
    const ledCheck = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'payment_ledger_entry_check'")).rows[0].d;
    assert.ok(!ledCheck.includes("offline_charge_refund_recorded"));
    const authCheck = (await admin.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'notification_write_authority_action_check'")).rows[0].d;
    assert.ok(!authCheck.includes("suppress"));
    assert.equal((await admin.query("SELECT booking.is_terminal_state('confirmed') AS t")).rows[0].t, true, "confirmed is a DB terminal state: 0001 intents_guard refuses confirmed -> test_cleanup_pending");
    assert.ok(!(await admin.query("SELECT pg_get_functiondef('booking.intents_guard()'::regprocedure) AS d")).rows[0].d.includes("test_cleanup_pending"));
    // THIS tree's pristine flows still run on the 0020 schema (the mirror column is written only when the leg is present): a RECORDED booking
    // is built, the pristine request refuses it (recording succeeded + notification present), and the recorded request fails closed on the
    // missing column with NOTHING written
    await admin.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
    const app = new pg.Pool({ connectionString: fresh.appUrl(), max: 4 });
    try {
      const c = await recordedUSD(app);
      const i = await loadIntent(app, c.id);
      const pristine = await requestTestCleanup(app, c.id, { now: F.at(20), env: ENV, operator: Object.freeze({ approvalRef: "SYNTHETIC-x", attemptId: c.attemptId, authorizedMinor: AMT, capturedMinor: AMT,
        chargeId: c.stripeChargeId, currency: "USD", expectedVersion: i.version, finalTotalMinor: AMT, from: i.from, guests: i.guests, intentId: c.id, listingId: LIST, paymentIntentId: c.piId,
        planHash: "0".repeat(64), reservationId: String(c.reservationId), sessionId: c.sessionId, to: i.to }) });
      assert.equal(pristine.ok, false, "the PRISTINE request never admits a recorded booking");
      await refusal(request(c, {}, ENV, app), /settlement_recording_mirrored/);
      assert.deepEqual([(await loadIntent(app, c.id)).status, (await rows(c.id, NOTIFY, app))[0].state], ["confirmed", "pending"], "RED: nothing written");
    } finally { await app.end(); }
  } finally { await admin.end(); fresh.stop(); }
});

test("S1 static reducer: new events / routes explicit and gated; E1 only from confirmed with every binding (ids never interchanged); E2 pristine two-flag rule byte-identical; E2b queues exactly ONE mirror effect only on the second flag; E3 gated; codec round trip of the third leg", () => {
  for (const e of ["TEST_CLEANUP_REQUESTED_RECORDED", "OFFLINE_CHARGE_REFUND_RECORDED"]) assert.ok(EVENTS.includes(e), e);
  assert.equal(EVENTS.length, 42);
  assert.deepEqual(TERMINAL_STATES, ["confirmed", "validation_failed", "expired", "payment_failed", "payment_expired", "authorization_released", "cancelled"]);
  assert.deepEqual(allowedEvents("confirmed"), ["PAYMENT_AUTHORIZED", "CAPTURE_SUCCEEDED", "TEST_CLEANUP_REQUESTED_RECORDED"]);
  assert.ok(allowedEvents("test_cleanup_pending").includes("OFFLINE_CHARGE_REFUND_RECORDED"));
  assert.ok(!allowedEvents("payment_captured").includes("TEST_CLEANUP_REQUESTED_RECORDED"), "the recorded request never enters from payment_captured");
  assert.equal(offlineRefundKey("11111111-2222-4333-8444-555555555555"), "ochr:11111111-2222-4333-8444-555555555555:1");
  assert.equal(TEST_CLEANUP_RECORDED_EXPECTATION_KEYS.length, 18);
  assert.equal(bindRecordedCleanupExpectation({}), null);
  // a confirmed, recorded intent (pure reducer)
  const now = F.at(10); const id = "11111111-2222-4333-8444-555555555555"; const pi = "pi_test_recorded_000001"; const rid = "9001"; const och = "500777";
  const base = createIntent({ id, ref: "MV-TREC01", listingId: LIST, from: "2027-05-01", to: "2027-05-03", guests: 2, now });
  const recorded = Object.freeze({ ...base, status: "confirmed", price: { ...base.price, currency: "USD", finalTotalMinor: AMT },
    payment: { paymentIntentId: pi, amountMinor: AMT, currency: "USD", livemode: false, capturedMinor: AMT, acceptedAt: now, captureBefore: now + F.DAY, authorizationCreatedAt: now, authorizationDeadline: now + F.DAY },
    reservation: { reservationId: rid, confirmedAt: now }, dispatch: { at: now, attempt: 1 }, counters: { ...base.counters, reservationAttempts: 1, captureAttempts: 1 }, offlineChargeId: och });
  const cfg = { testCleanupEnabled: true, expectedLivemode: false };
  const ev = (over = {}) => ({ type: "TEST_CLEANUP_REQUESTED_RECORDED", id: testCleanupRecordedEventId(id, pi, rid, och), paymentIntentId: pi, reservationId: rid, stripeChargeId: "ch_test_recorded_1", offlineChargeId: och, ...over });
  const ok = transition(recorded, ev(), { now, config: cfg });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.intent.status, ok.intent.reasonCode, ok.intent.settlement, ok.intent.counters.cancelAttempts, ok.intent.offlineChargeId],
    ["test_cleanup_pending", "TEST_CLEANUP_REQUESTED", { reservationCancelled: false, authorizationSettled: false, recordingMirrored: false }, 1, och]);
  assert.deepEqual(ok.effects.map((e) => e.type), ["hostaway.cancel_reservation", "stripe.refund_payment_intent"], "the mirror is NOT queued at the request");
  assert.equal(ok.effects[1].chargeId, "ch_test_recorded_1"); assert.equal(ok.effects[1].idempotencyKey, refundKey(id, 1));
  const rej = (o, c = cfg, intent = recorded) => transition(intent, ev(o), { now, config: c }).error;
  assert.equal(rej({}, {}), "TEST_CLEANUP_DISABLED");
  assert.equal(rej({}, { testCleanupEnabled: true, expectedLivemode: true }), "TEST_CLEANUP_TEST_MODE_ONLY");
  assert.equal(rej({ stripeChargeId: och }), "TEST_CLEANUP_CHARGE_INVALID", "a Hostaway id in stripeChargeId");
  assert.equal(rej({ offlineChargeId: "ch_test_recorded_1" }), "TEST_CLEANUP_RECORDED_CHARGE_MISMATCH", "a Stripe id in offlineChargeId");
  assert.equal(rej({ offlineChargeId: "500778", id: testCleanupRecordedEventId(id, pi, rid, "500778") }), "TEST_CLEANUP_RECORDED_CHARGE_MISMATCH", "another offline charge");
  assert.equal(rej({ id: testCleanupRecordedEventId(id, pi, rid, "500778") }), "TEST_CLEANUP_EVENT_ID");
  assert.equal(rej({ reservationId: "9002" }), "TEST_CLEANUP_RESERVATION_MISMATCH");
  assert.equal(rej({ paymentIntentId: "pi_test_other_000001" }), "TEST_CLEANUP_PAYMENT_MISMATCH");
  assert.equal(rej({}, cfg, { ...recorded, offlineChargeId: null }), "TEST_CLEANUP_RECORDED_CHARGE_MISMATCH", "a PRISTINE (unrecorded) booking is never admitted by the recorded event");
  assert.equal(rej({}, cfg, { ...recorded, counters: { ...recorded.counters, offlineChargeAttempts: 1 } }), "TEST_CLEANUP_HISTORY", "a failed recording attempt in the history refuses");
  assert.equal(rej({}, cfg, { ...recorded, payment: { ...recorded.payment, livemode: true } }), "TEST_CLEANUP_PAYMENT_NOT_TEST_CAPTURED");
  assert.equal(transition({ ...recorded, status: "payment_captured", offlineChargeId: null }, ev(), { now, config: cfg }).error, "ILLEGAL_TRANSITION", "not routed from payment_captured");
  // E2: pristine two-flag rule (key ABSENT) unchanged → cancelled, [] effects
  const pend2 = { ...ok.intent, settlement: { reservationCancelled: true, authorizationSettled: false } };
  const t2 = transition(pend2, { type: "REFUND_SUCCEEDED", id: "r2", refundId: "re_test_1", chargeId: "ch_test_recorded_1", amountMinor: AMT, currency: "USD" }, { now, config: cfg });
  assert.deepEqual([t2.ok, t2.intent.status, t2.effects.length], [true, "cancelled", 0]);
  // E2 recorded (key PRESENT, false): the second flag keeps test_cleanup_pending and queues exactly ONE mirror effect (either order)
  for (const [first, second] of [["reservationCancelled", "REFUND_SUCCEEDED"], ["authorizationSettled", "RESERVATION_CANCELLED"]]) {
    const one = transition({ ...ok.intent, settlement: { ...ok.intent.settlement, [first]: true } },
      second === "REFUND_SUCCEEDED" ? { type: second, id: "s", refundId: "re_test_1", chargeId: "ch_test_recorded_1", amountMinor: AMT, currency: "USD" } : { type: second, id: "s" }, { now, config: cfg });
    assert.equal(one.ok, true, JSON.stringify(one));
    assert.deepEqual([one.intent.status, one.intent.settlement], ["test_cleanup_pending", { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false }]);
    assert.deepEqual(one.effects, [{ type: MIRROR, reservationId: rid, offlineChargeId: och, amountMinor: AMT, currency: "USD", idempotencyKey: offlineRefundKey(id) }]);
    // the FIRST flag alone queues nothing
    const firstOnly = transition(ok.intent, second === "REFUND_SUCCEEDED" ? { type: "RESERVATION_CANCELLED", id: "f" } : { type: "REFUND_SUCCEEDED", id: "f", refundId: "re_test_1", chargeId: "ch_test_recorded_1", amountMinor: AMT, currency: "USD" }, { now, config: cfg });
    assert.deepEqual([firstOnly.ok, firstOnly.intent.status, firstOnly.effects.length], [true, "test_cleanup_pending", 0]);
    // E3 only now: → cancelled, flag true, [] effects (nothing notified)
    const e3 = (over = {}, intent = one.intent) => transition(intent, { type: "OFFLINE_CHARGE_REFUND_RECORDED", id: "m", offlineChargeId: och, offlineRefundId: "500784", amountMinor: AMT, currency: "usd", ...over }, { now, config: cfg });
    const done = e3();
    assert.deepEqual([done.ok, done.intent.status, done.intent.settlement, done.effects.length], [true, "cancelled", { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }, 0]);
    assert.equal(e3({}, ok.intent).error, "MIRROR_LEGS_NOT_SETTLED", "never after fewer than two proven legs");
    assert.equal(e3({}, firstOnly.intent).error, "MIRROR_LEGS_NOT_SETTLED");
    assert.equal(e3({ offlineChargeId: "500778" }).error, "MIRROR_ORIGINAL_MISMATCH");
    assert.equal(e3({ offlineRefundId: och }).error, "MIRROR_REFUND_ID_INVALID", "the refund row id is never the original");
    assert.equal(e3({ offlineRefundId: "re_test_1" }).error, "MIRROR_REFUND_ID_INVALID");
    assert.equal(e3({ amountMinor: AMT - 1 }).error, "MIRROR_NOT_FULL");
    assert.equal(e3({ currency: "MXN" }).error, "MIRROR_NOT_FULL");
    assert.equal(e3({}, pend2).error, "MIRROR_NOT_OPEN", "a pristine cleanup has no mirror leg");
    assert.equal(e3({ id: "m2" }, done.intent).error, "ILLEGAL_TRANSITION", "nothing leaves cancelled");
  }
  // codec: the third leg round-trips only when present; MUTABLE_COLUMNS carries the column
  assert.ok(!MUTABLE_COLUMNS.includes(MIRROR_COLUMN), "the pristine CAS statement is unchanged: the mirror column is written only when the leg is present");
  assert.equal(MIRROR_COLUMN, "settlement_recording_mirrored"); assert.equal(hasMirrorLeg(ok.intent), true); assert.equal(hasMirrorLeg(pend2), false); assert.equal(hasMirrorLeg(recorded), false);
  const r3 = intentToRow(ok.intent); assert.equal(r3.settlement_recording_mirrored, false); assert.equal(r3.settlement_reservation_cancelled, false);
  assert.equal(intentToRow(pend2).settlement_recording_mirrored, null, "pristine: NULL");
  assert.equal(intentToRow(recorded).settlement_recording_mirrored, null);
  const back = rowToIntent({ ...r3, from_date: "2027-05-01", to_date: "2027-05-03", version: 3, created_at: new Date(now), updated_at: new Date(now), price_snapshot: {}, machine_version: "intent-state-v1", listing_id: LIST, guests: 2, detail: {} });
  assert.deepEqual(back.settlement, { reservationCancelled: false, authorizationSettled: false, recordingMirrored: false });
  assert.deepEqual(rowToIntent({ ...r3, settlement_recording_mirrored: null, from_date: "2027-05-01", to_date: "2027-05-03", version: 3, created_at: new Date(now), updated_at: new Date(now), price_snapshot: {}, machine_version: "intent-state-v1", listing_id: LIST, guests: 2, detail: {} }).settlement,
    { reservationCancelled: false, authorizationSettled: false }, "NULL column → two keys (pristine rule)");
});

test("Q1 REAL recorded request: confirmed → test_cleanup_pending with settlement {false,false,false}, EXACTLY cancel + bound Stripe refund rows, NO mirror row; the recording row UNCHANGED (succeeded, linked); the pristine guest.notify row superseded in the SAME tx with ONE audit row; payment_refunds requested; ledger unchanged; replay duplicate; claim held", async () => {
  const c = await recordedUSD();
  const rec0 = await rows(c.id, RECORD); const led0 = await ledger(c.id); const cap0 = await rows(c.id, CAP);
  const r = await request(c);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.duplicate, false);
  assert.deepEqual(r.operations.map((o) => `${o.opType}:${o.inserted}`).sort(), ["hostaway.cancel_reservation:true", "stripe.refund_payment_intent:true"]);
  const i = await loadIntent(db.app, c.id);
  assert.deepEqual([i.status, i.reasonCode, i.settlement, i.offlineChargeId], ["test_cleanup_pending", "TEST_CLEANUP_REQUESTED", { reservationCancelled: false, authorizationSettled: false, recordingMirrored: false }, c.offlineChargeId]);
  assert.deepEqual(await intentRow(c.id).then((x) => [x.rc, x.a, x.m, x.offline_charge_id]), [false, false, false, c.offlineChargeId], "persisted third leg");
  assert.deepEqual(await rows(c.id, RECORD), rec0, "recording row byte-identical (NOT retired)");
  assert.deepEqual(await rows(c.id, CAP), cap0); assert.deepEqual(await ledger(c.id), led0, "ledger unchanged by the request");
  assert.equal((await rows(c.id, MIRROR)).length, 0, "the mirror row does not exist before both legs are proven");
  const rf = (await rows(c.id, REFUND))[0];
  assert.deepEqual([rf.state, rf.payload.chargeId, rf.payload.providerIdempotencyKey, rf.payload.amountMinor], ["pending", c.stripeChargeId, refundKey(c.id, 1), AMT]);
  const n = (await rows(c.id, NOTIFY))[0];
  assert.deepEqual([n.id, n.state, n.attempts, n.dispatched_at, n.lease_worker_id], [c.notifyOpId, "superseded", 0, null, null], "suppressed, never attempted");
  const sup = await suppressions(c.id);
  assert.deepEqual(sup.map((s) => [s.operation_id, s.intent_version, s.reason]), [[c.notifyOpId, i.version, "TEST_CLEANUP_RECORDED"]]);
  await refusal(db.app.query("SELECT count(*)::int AS n FROM booking.notification_write_authority"), /permission denied/);
  assert.equal(await F.count(db.owner, "SELECT count(*) AS n FROM booking.notification_write_authority WHERE operation_id = $1", [c.notifyOpId]), 0, "no token left behind");
  const refunds = (await db.app.query("SELECT seq, state, hostaway_state, amount_minor::text AS amt FROM booking.payment_refunds WHERE intent_id = $1", [c.id])).rows;
  assert.deepEqual(refunds, [{ seq: 1, state: "requested", hostaway_state: "not_applicable", amt: String(AMT) }]);
  const again = await request(c, { expectedVersion: i.version - 1 });
  assert.deepEqual([again.ok, again.duplicate], [true, true], "replay = duplicate, nothing re-written");
  assert.equal((await suppressions(c.id)).length, 1); assert.ok(await held(c.id));
  assert.deepEqual(await claimReleaseBlockers(db.app, c.id), ["STATE_NOT_RELEASABLE:test_cleanup_pending"]);
  // a REAL dispatcher claim after the suppression: NOT_PENDING (the row is out of every notification path)
  const cl = (await db.app.query("SELECT booking.claim_guest_notification($1, 'gn-late', 'gn-v1', $2, $2, $2) AS r", [c.notifyOpId, "0".repeat(64)])).rows[0].r;
  assert.deepEqual(cl, { status: "not_claimable", code: "NOT_PENDING" });
});

test("Q2 REAL refusals (ZERO writes): the pristine request on a recorded booking; the recorded request on an unrecorded (payment_captured) booking; swapped / foreign ids; stale version; gate closed; wrong listing; a SYNTHETIC claimed / rendered / latched / leased notification row (fence refusal, nothing written, intent stays confirmed)", async () => {
  const c = await recordedUSD();
  const snapshot = async () => [await intentRow(c.id), await rows(c.id, NOTIFY), await rows(c.id, RECORD), await rows(c.id, REFUND), await rows(c.id, CANCEL), await suppressions(c.id),
    (await db.app.query("SELECT count(*)::int AS n FROM booking.payment_refunds WHERE intent_id = $1", [c.id])).rows[0].n];
  const s0 = await snapshot();
  const i = await loadIntent(db.app, c.id);
  const pristine = await requestTestCleanup(db.app, c.id, { now: F.at(20), env: ENV, operator: Object.freeze({ approvalRef: "SYNTHETIC-x", attemptId: c.attemptId, authorizedMinor: AMT, capturedMinor: AMT,
    chargeId: c.stripeChargeId, currency: "USD", expectedVersion: i.version, finalTotalMinor: AMT, from: i.from, guests: i.guests, intentId: c.id, listingId: LIST, paymentIntentId: c.piId,
    planHash: "0".repeat(64), reservationId: String(c.reservationId), sessionId: c.sessionId, to: i.to }) });
  assert.equal(pristine.ok, false, "the PRISTINE request never admits a recorded booking");
  assert.equal((await request(c, {}, { VERCEL_ENV: "production", MV_E7_TEST_CLEANUP: "enabled" })).error, "TEST_CLEANUP_GATE_CLOSED");
  assert.equal((await request(c, { stripeChargeId: c.offlineChargeId })).error, "TEST_CLEANUP_EXPECTATION_INVALID", "Hostaway id as the Stripe charge");
  assert.equal((await request(c, { offlineChargeId: c.stripeChargeId })).error, "TEST_CLEANUP_EXPECTATION_INVALID", "Stripe id as the offline charge");
  assert.equal((await request(c, { offlineChargeId: String(c.reservationId) })).error, "TEST_CLEANUP_EXPECTATION_INVALID", "the reservation id as the offline charge");
  assert.equal((await request(c, { offlineChargeId: String(Number(c.offlineChargeId) + 1) })).error, "TEST_CLEANUP_RECORDED_CHARGE_MISMATCH", "another offline charge: reducer binding");
  assert.equal((await request(c, { stripeChargeId: "ch_test_other_000000001" })).error, "TEST_CLEANUP_CAPTURE_NOT_PROVEN", "another Stripe charge: in-tx capture binding");
  assert.equal((await request(c, { expectedVersion: i.version + 1 })).error, "TEST_CLEANUP_STALE");
  assert.equal((await request(c, { listingId: 603566, currency: "MXN" })).error, "TEST_CLEANUP_LISTING_NOT_ALLOWED");
  assert.equal((await request(c, { reservationId: "70636076" })).error, "TEST_CLEANUP_RESERVATION_PROTECTED");
  assert.deepEqual(await snapshot(), s0, "ZERO writes");
  // an UNRECORDED booking (payment_captured, pristine recording): the recorded request is not an allowed event there
  const p = await capturedUSD();
  const rp = await requestRecordedTestCleanup(db.app, p.id, { now: F.at(20), env: ENV, operator: await expectationFor({ ...p, offlineChargeId: "500999" }) });
  assert.equal(rp.ok, false); assert.equal((await loadIntent(db.app, p.id)).status, "payment_captured");
  // SYNTHETIC notification shapes (owner, committed, then undone): each refuses the request read-only
  const op = c.notifyOpId;
  const undo = async () => synthetic("UPDATE booking.external_operations SET state = 'pending', attempts = 0, dispatched_at = NULL, lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op]);
  for (const [label, sql, params, code] of [
    ["claimed (attempts 1, dispatched, in_flight)", "UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'gn-x', lease_until = now() + interval '60 seconds' WHERE id = $1", [op], "NOTIFY_SUPPRESS_REFUSED"],
    ["attempted (attempts 1, pending)", "UPDATE booking.external_operations SET attempts = 1, dispatched_at = now() WHERE id = $1", [op], "NOTIFY_SUPPRESS_REFUSED"],
    ["leased only", "UPDATE booking.external_operations SET lease_worker_id = 'gn-x', lease_until = now() + interval '60 seconds' WHERE id = $1", [op], "NOTIFY_SUPPRESS_REFUSED"]]) {
    await synthetic(sql, params);
    const r = await request(c);
    assert.equal(r.error, code, `${label}: ${JSON.stringify(r)}`);
    await undo();
  }
  await synthetic("INSERT INTO booking.notification_renders (operation_id, intent_id, template, template_version, intent_version, facts, facts_hash, recipient_hash, content_hash, message_ref, worker, claimed_at) VALUES ($1, $2, 'booking_confirmed', 'gn-v1', 1, '{}', $3, $3, $3, $4, 'gn-x', now())", [op, c.id, "0".repeat(64), `gn1-${op}`]);
  assert.equal((await request(c)).error, "NOTIFY_SUPPRESS_REFUSED", "rendered");
  await synthetic("DELETE FROM booking.notification_renders WHERE operation_id = $1", [op]);
  await synthetic("INSERT INTO booking.notification_latches (operation_id, intent_id, code, intent_version_seen, latched_at, worker) VALUES ($1, $2, 'OPEN_CASE', 1, now(), 'gn-x')", [op, c.id]);
  assert.equal((await request(c)).error, "NOTIFY_SUPPRESS_REFUSED", "latched: owner-visible, never suppressed");
  await synthetic("DELETE FROM booking.notification_latches WHERE operation_id = $1", [op]);
  assert.deepEqual(await snapshot(), s0, "ZERO writes after every refusal");
  // and after the surrogates are undone the real request succeeds
  F.ok(await request(c), "request after undo");
});

test("Q3 two-session race at the intent row with SYNTHETIC claimant surrogates (owner trigger-bypass; the REAL claim_guest_notification race is Q13): a notification claimant holding the intent lock first → the request waits, then refuses read-only (claim wins, intent stays confirmed); request first → the later REAL claim is NOT_PENDING", async () => {
  // (a) claimant first: session 1 takes the gn_lock_bundle first lock (intents FOR SHARE), the request blocks on FOR NO KEY UPDATE, session 1
  //     writes the SYNTHETIC claim surrogate and commits; the request then sees attempts 1 and refuses with nothing written
  const c = await recordedUSD();
  const s1 = await db.owner.connect();
  try {
    await s1.query("BEGIN"); await s1.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR SHARE", [c.id]);
    const pending = request(c);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await db.owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ~ 'booking.intents' AND state = 'active'")).rows[0].n >= 1, true, "the request waits at the intent row");
    await s1.query("SET LOCAL session_replication_role = replica");
    await s1.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'gn-race', lease_until = now() + interval '60 seconds' WHERE id = $1", [c.notifyOpId]);
    await s1.query("COMMIT");
    const r = await pending;
    assert.equal(r.error, "NOTIFY_SUPPRESS_REFUSED", JSON.stringify(r));
    assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.m]), ["confirmed", null]); assert.equal((await suppressions(c.id)).length, 0);
    assert.deepEqual((await rows(c.id, NOTIFY)).map((o) => [o.state, o.attempts]), [["in_flight", 1]], "the claimant's row is untouched");
  } finally { await s1.query("ROLLBACK").catch(() => {}); s1.release(); }
  // (b) request first (committed) → a REAL claim_guest_notification is NOT_PENDING; superseded leaves every notification path
  const d = await recordedUSD();
  F.ok(await request(d));
  const cl = (await db.app.query("SELECT booking.claim_guest_notification($1, 'gn-race2', 'gn-v1', $2, $2, $2) AS r", [d.notifyOpId, "0".repeat(64)])).rows[0].r;
  assert.deepEqual(cl, { status: "not_claimable", code: "NOT_PENDING" });
  assert.deepEqual((await db.app.query("SELECT booking.recover_expired_notifications($1, $2, 10) AS r", [[LIST], d.id])).rows[0].r.recovered ?? 0, 0, "recovery ignores it");
  // (c) concurrent request + claimant surrogate both racing from a barrier: exactly one winner, never both, never neither
  const e = await recordedUSD();
  const s2 = await db.owner.connect();
  const claimant = (async () => {
    try {
      await s2.query("BEGIN"); await s2.query("SET LOCAL session_replication_role = replica");
      await s2.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR SHARE", [e.id]);
      const n = (await s2.query("SELECT state FROM booking.external_operations WHERE id = $1 FOR UPDATE", [e.notifyOpId])).rows[0].state;
      if (n === "pending") await s2.query("UPDATE booking.external_operations SET state = 'in_flight', attempts = 1, dispatched_at = now(), lease_worker_id = 'gn-race3', lease_until = now() + interval '60 seconds' WHERE id = $1", [e.notifyOpId]);
      await s2.query("COMMIT"); return n === "pending" ? "claimed" : "not_pending";
    } catch (err) { await s2.query("ROLLBACK").catch(() => {}); throw err; } finally { s2.release(); }
  })();
  const [cr, rr] = await Promise.all([claimant, request(e)]);
  const final = (await rows(e.id, NOTIFY))[0];
  if (cr === "claimed") { assert.equal(rr.ok, false); assert.deepEqual([final.state, final.attempts], ["in_flight", 1]); assert.equal((await intentRow(e.id)).state, "confirmed"); }
  else { assert.equal(rr.ok, true, JSON.stringify(rr)); assert.deepEqual([final.state, final.attempts], ["superseded", 0]); assert.equal((await intentRow(e.id)).state, "test_cleanup_pending"); }
});

test("Q4 REAL legs: after the cancel leg alone / the refund leg alone the intent stays pending with NO mirror row; after BOTH (either order) it STAYS test_cleanup_pending, claim held, with EXACTLY ONE pristine mirror row (key ochr:<intent>:1, bound payload); the terminal is refused before the mirror is proven", async () => {
  for (const refundFirst of [false, true]) {
    const c = await recordedUSD();
    F.ok(await request(c));
    const first = refundFirst ? (await refundLeg(c, 24)).r : await cancelLeg(c, 24);
    F.ok(first, "first leg");
    assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.rc, x.a, x.m]), ["test_cleanup_pending", !refundFirst, refundFirst, false]);
    assert.equal((await rows(c.id, MIRROR)).length, 0, "no mirror after ONE leg");
    const second = refundFirst ? await cancelLeg(c, 28) : (await refundLeg(c, 28)).r;
    F.ok(second, "second leg");
    assert.deepEqual(second.operations.map((o) => `${o.opType}:${o.inserted}`), [`${MIRROR}:true`], "the second leg queues the ONE mirror op");
    const i = await loadIntent(db.app, c.id);
    assert.deepEqual([i.status, i.settlement], ["test_cleanup_pending", { reservationCancelled: true, authorizationSettled: true, recordingMirrored: false }], "STILL pending after two proven legs");
    assert.ok(await held(c.id), "claim held");
    const m = await rows(c.id, MIRROR);
    assert.deepEqual(m.map((o) => [o.state, o.attempts, o.idempotency_key, o.payload]), [["pending", 0, offlineRefundKey(c.id), { reservationId: String(c.reservationId), offlineChargeId: c.offlineChargeId, amountMinor: AMT, currency: "USD" }]]);
    // terminal before the mirror is proven: the reducer would move, the DB refuses (flag false → true without offline_refund_settled_for)
    const early = await terminal(c);
    assert.equal(early.ok, false); assert.equal(early.error, "MIRROR_NOT_VERIFIED");
    assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.m]), ["test_cleanup_pending", false]);
    assert.equal(await settledFor(c.id), false);
    // a second mirror row (any key) never exists
    await refusal(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, next_attempt_at, created_at, updated_at)
      SELECT gen_random_uuid(), intent_id, op_type, 'ochr:' || intent_id::text || ':2', retry_class, 'pending', payload, source_version, max_attempts, now(), now(), now() FROM booking.external_operations WHERE id = $1`, [m[0].id]), /MIRROR_CREATE_FENCED|one_offline_refund_ever/);
  }
  // the creation fence alone (a mirror row before both legs / on a pristine cleanup): refused regardless of the reducer
  const d = await recordedUSD(); F.ok(await request(d));
  await refusal(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'reconcile_first', 'pending', $4, 1, 1, now(), now(), now())`,
    [d.id, MIRROR, offlineRefundKey(d.id), { reservationId: String(d.reservationId), offlineChargeId: d.offlineChargeId, amountMinor: AMT, currency: "USD" }]), /MIRROR_CREATE_FENCED/);
});

test("Q5 REAL mirror: claim (attempt 1 only) → typed LIST proof → complete_offline_refund_with_evidence → OFFLINE_CHARGE_REFUND_RECORDED → cancelled with {true,true,true}, ledger offline_charge_refund_recorded (magnitude, hostaway, refund row id), claim released, recorded_state_cleanup_ok; notification stays superseded; generic completion / second claim refused", async () => {
  const c = await bothLegs(await recordedUSD());
  // generic completion (no proof, app role) cannot succeed the mirror
  const op = await claimMirror(c);
  assert.equal(op.id, c.mirrorOpId); assert.equal(op.payload.offlineChargeId, c.offlineChargeId);
  const generic = await completeOperation(db.app, c.mirrorOpId, { workerId: "w-mirror", now: Date.now(), outcome: { status: "succeeded", resultRef: refundIdOf(c) } });
  assert.equal(generic.ok, false, JSON.stringify(generic)); assert.match(String(generic.error), /MIRROR_SUCCESS_REQUIRES_FUNCTION/);
  assert.deepEqual((await rows(c.id, MIRROR)).map((o) => [o.state, o.attempts]), [["in_flight", 1]]);
  const { ev, r } = await completeMirror(c);
  assert.deepEqual(r, { ok: true, state: "succeeded" }, JSON.stringify(r));
  const m = (await rows(c.id, MIRROR))[0];
  assert.deepEqual([m.state, m.result_ref, m.settled_evidence_id, m.lease_worker_id], ["succeeded", refundIdOf(c), ev, null]);
  assert.equal(await settledFor(c.id), true);
  assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.m]), ["test_cleanup_pending", false], "the mirror success alone does not move the intent");
  const t = await terminal(c);
  assert.equal(t.ok, true, JSON.stringify(t)); assert.equal(t.effects.length, 0, "nothing queued at the terminal");
  const i = await loadIntent(db.app, c.id);
  assert.deepEqual([i.status, i.reasonCode, i.settlement, i.offlineChargeId], ["cancelled", "TEST_CLEANUP_REQUESTED", { reservationCancelled: true, authorizationSettled: true, recordingMirrored: true }, c.offlineChargeId]);
  const led = await ledger(c.id);
  assert.deepEqual(led.filter((l) => l.entry === "offline_charge_refund_recorded"), [{ entry: "offline_charge_refund_recorded", amt: String(AMT), currency: "USD", provider: "hostaway", provider_ref: refundIdOf(c) }]);
  assert.deepEqual(led.map((l) => l.entry), ["authorization_accepted", "capture_succeeded", "offline_charge_recorded", "refund_succeeded", "offline_charge_refund_recorded"]);
  assert.equal(await held(c.id), false, `claim released at the terminal: ${JSON.stringify(await claimReleaseBlockers(db.app, c.id))}`);
  assert.deepEqual((await rows(c.id, NOTIFY)).map((o) => [o.state, o.attempts]), [["superseded", 0]]); assert.equal((await rows(c.id, "alert.owner")).length, 0);
  assert.equal(await endOk(c.id), true, "recorded_state_cleanup_ok");
  assert.deepEqual(await claimReleaseBlockers(db.app, c.id), []);
  // a replay of the terminal is a duplicate; a second mirror claim is impossible (succeeded)
  const again = await terminal(c); assert.deepEqual([again.ok, again.duplicate], [true, true]);
  assert.equal(await claimNextOperation(db.app, { workerId: "w-mirror", now: Date.now(), intentId: c.id, opTypes: [MIRROR] }), null);
});

test("Q6 REAL negative mirror proofs: each field altered ALONE is refused by the completion function (MIRROR_PROOF_REFUSED) and the row stays in_flight; stale / pre-send evidence refused; a wrong worker / version refused", async () => {
  const c = await bothLegs(await recordedUSD(), { refundFirst: true });
  const op = await claimMirror(c);
  const rid = refundIdOf(c);
  const cases = [
    ["inverted link (refundedChargeId = the refund row)", mirrorObserved(c, rid, {}, {}, { refundedChargeId: rid }), /MIRROR_LINK_REFUNDED_ID/],
    ["foreign original", mirrorObserved(c, rid, {}, {}, { refundedChargeId: String(Number(c.offlineChargeId) + 1) }), /MIRROR_LINK_REFUNDED_ID/],
    ["link chargeId is not the row", mirrorObserved(c, rid, {}, {}, { chargeId: c.offlineChargeId }), /MIRROR_LINK_CHARGE_ID/],
    ["untyped link id (number)", mirrorObserved(c, rid, {}, {}, { chargeId: Number(rid) }), /MIRROR_LINK_CHARGE_ID/],
    ["missing link key", (() => { const o = mirrorObserved(c, rid); delete o.refundRow.refundInfo.refundedChargeId; return o; })(), /MIRROR_LINK_KEYS/],
    ["partial amount", mirrorObserved(c, rid, {}, { amountMinor: -(AMT - 100) }), /MIRROR_ROW_AMOUNT/],
    ["positive amount", mirrorObserved(c, rid, {}, { amountMinor: AMT }), /MIRROR_ROW_AMOUNT/],
    ["refund status pending", mirrorObserved(c, rid, {}, { status: "pending" }), /MIRROR_ROW_STATUS/],
    ["provider stripe", mirrorObserved(c, rid, {}, { paymentProvider: "stripe" }), /MIRROR_ROW_PROVIDER/],
    ["type charge", mirrorObserved(c, rid, {}, { type: "charge" }), /MIRROR_ROW_TYPE/],
    ["other reservation", mirrorObserved(c, rid, {}, { reservationId: String(Number(c.reservationId) + 1) }), /MIRROR_ROW_RESERVATION/],
    ["other currency", mirrorObserved(c, rid, {}, { currency: "MXN" }), /MIRROR_ROW_CURRENCY/],
    ["lookalike title", mirrorObserved(c, rid, {}, { title: `maraVilla refund mvochr1-${c.id}​` }), /MIRROR_ROW_TITLE/],
    ["two linked rows", mirrorObserved(c, rid, { linkedRefundCount: 2 }), /MIRROR_LINKED_COUNT/],
    ["no linked row", mirrorObserved(c, rid, { linkedRefundCount: 0 }), /MIRROR_LINKED_COUNT/],
    ["two marker matches", mirrorObserved(c, rid, { matchingRefundCount: 2, matchingRefundIds: [rid, String(Number(rid) + 1)] }), /MIRROR_COUNT/],
    ["marker match is another row", mirrorObserved(c, rid, { matchingRefundIds: [String(Number(rid) + 1)] }), /MIRROR_IDS/],
    ["wrong mirror marker", mirrorObserved(c, rid, { mirrorMarker: `mvoch1-${c.id}` }), /MIRROR_MARKER/],
    ["original now refunded/changed status", mirrorObserved(c, rid, { status: "refunded" }), /ORIGINAL_STATUS/],
    ["original amount changed", mirrorObserved(c, rid, { amountMinor: AMT - 1 }), /ORIGINAL_AMOUNT/],
    ["original id missing from the list", mirrorObserved(c, rid, { matchingChargeCount: 0, matchingChargeIds: [] }), /ORIGINAL_COUNT/],
    ["extra key (unknown field)", mirrorObserved(c, rid, { replyEcho: true }), /OBSERVED_KEYS/],
    ["refundRow missing a key", (() => { const o = mirrorObserved(c, rid); delete o.refundRow.paymentProvider; return o; })(), /MIRROR_ROW_KEYS/]
  ];
  for (const [label, observed, re] of cases) {
    const { r } = await completeMirror(c, { observed });
    assert.equal(r.ok, false, `${label}: ${JSON.stringify(r)}`); assert.match(String(r.error), /MIRROR_PROOF_REFUSED/, label);
    assert.deepEqual((await rows(c.id, MIRROR)).map((o) => [o.state, o.attempts, o.settled_evidence_id]), [["in_flight", 1, null]], label);
    assert.equal(await settledFor(c.id), false, label);
    // the exact SQL reason, as the owner sees it
    const reason = (await db.owner.query("SELECT booking.offline_refund_proof_refusal($1, $2, $3, $4, (SELECT id FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'hostaway_offline_charges' ORDER BY observed_at DESC, id DESC LIMIT 1), 'linked', clock_timestamp()) AS r",
      [c.id, op.payload, rid, op.dispatched_at])).rows[0].r;
    assert.match(String(reason), re, `${label}: ${reason}`);
  }
  // a wrong result ref (another row id / the original) with an otherwise valid proof
  assert.match(String((await completeMirror(c, { refundId: c.offlineChargeId })).r.error), /MIRROR_PROOF_REFUSED/, "result ref = the original");
  // stale evidence (> 2 minutes before the decision) / evidence observed before the send
  assert.match(String((await completeMirror(c, { at: Date.now() - 3 * F.MIN })).r.error), /MIRROR_PROOF_REFUSED/, "stale");
  assert.match(String((await completeMirror(c, { at: new Date(op.dispatched_at).getTime() - 1000 })).r.error), /MIRROR_PROOF_REFUSED/, "before the send");
  // wrong worker / stale version
  const { version } = (await db.app.query("SELECT version FROM booking.intents WHERE id = $1", [c.id])).rows[0];
  const ev = await listEvidence(c, mirrorObserved(c));
  assert.equal((await completeOfflineRefundWithEvidence(db.app, c.mirrorOpId, { workerId: "w-other", evidenceId: ev, resultRef: rid, expectedVersion: version })).error, "MIRROR_WORK_LEASE_LOST");
  assert.equal((await completeOfflineRefundWithEvidence(db.app, c.mirrorOpId, { workerId: "w-mirror", evidenceId: ev, resultRef: rid, expectedVersion: version + 1 })).error, "MIRROR_VERSION_CHANGED");
  // and the same proof, fresh, completes
  assert.deepEqual((await completeMirror(c)).r, { ok: true, state: "succeeded" });
});

test("Q7 latest-consistent persisted proof: a LATER contradicting LIST observation withdraws the settlement (terminal refused, flag stays false); a tie (two observations at one instant, different content) refuses; a later consistent observation restores it; after the terminal a contradiction cannot reopen anything", async () => {
  const c = await bothLegs(await recordedUSD());
  await claimMirror(c);
  assert.deepEqual((await completeMirror(c)).r, { ok: true, state: "succeeded" });
  assert.equal(await settledFor(c.id), true);
  // a later observation shows NO linked refund any more → not settled → the terminal is refused (observation times: the DB clock must not see them in the future)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(20);
  await listEvidence(c, mirrorObserved(c, refundIdOf(c), { linkedRefundCount: 0, matchingRefundCount: 0, matchingRefundIds: [] }), Date.now() - 5);
  assert.equal(await settledFor(c.id), false, "the latest observation decides");
  const t1 = await terminal(c); assert.equal(t1.ok, false); assert.equal(t1.error, "MIRROR_NOT_VERIFIED");
  assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.m]), ["test_cleanup_pending", false]);
  // a tie: two observations at the same instant with different content (SYNTHETIC: the owner pins observed_at of a second real evidence row to the first's)
  await sleep(20);
  const okEv = await listEvidence(c, mirrorObserved(c), Date.now() - 5);
  assert.equal(await settledFor(c.id), true, "a later consistent observation restores it");
  await sleep(20);
  const badEv = await listEvidence(c, mirrorObserved(c, refundIdOf(c), { linkedRefundCount: 2 }), Date.now() - 5);
  assert.equal(await settledFor(c.id), false);
  await synthetic(`UPDATE booking.provider_evidence SET observed_at = (SELECT observed_at FROM booking.provider_evidence WHERE id = $1) WHERE id = $2;
                   UPDATE booking.external_operations SET completed_at = (SELECT observed_at FROM booking.provider_evidence WHERE id = $1)
                    WHERE id = (SELECT read_operation_id FROM booking.provider_evidence WHERE id = $2)`.replace(/\$1/g, `'${okEv}'`).replace(/\$2/g, `'${badEv}'`), []);
  assert.equal(await settledFor(c.id), false, "tie with different content → refused");
  await synthetic("UPDATE booking.provider_evidence SET observed = (SELECT observed FROM booking.provider_evidence WHERE id = $1) WHERE id = $2", [okEv, badEv]);
  assert.equal(await settledFor(c.id), true, "tie with identical content → consistent");
  const t2 = await terminal(c); assert.equal(t2.ok, true, JSON.stringify(t2));
  assert.equal(await endOk(c.id), true);
  // after the terminal: a contradiction changes nothing (terminal state; flags only move forward; no transition leaves cancelled but a late auth)
  await sleep(20);
  await listEvidence(c, mirrorObserved(c, refundIdOf(c), { linkedRefundCount: 0, matchingRefundCount: 0, matchingRefundIds: [] }), Date.now() - 5);
  assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.rc, x.a, x.m]), ["cancelled", true, true, true]);
  assert.equal(await endOk(c.id), false, "the end predicate honestly reports the later contradiction (owner review), the state itself is immutable");
});

test("Q8 immutability / discriminator (direct writes, owner and app): the flag never goes NULL→TRUE, FALSE→NULL, TRUE→FALSE, nor FALSE on a pristine cleanup; offline_charge_id immutable; the terminal with the flag bypassed to NULL is STILL refused (fact-derived); a pristine 0019 cleanup carrying a flag is refused", async () => {
  const c = await bothLegs(await recordedUSD());
  const tryUpd = (pool, sql, params, re) => refusal(pool.query(sql, params), re);
  for (const pool of [db.app, db.owner]) {
    await tryUpd(pool, "UPDATE booking.intents SET settlement_recording_mirrored = NULL, version = version + 1 WHERE id = $1", [c.id], /MIRROR_FLAG_IMMUTABLE|intents_guard|version/);
    await tryUpd(pool, "UPDATE booking.intents SET settlement_recording_mirrored = TRUE, version = version + 1 WHERE id = $1", [c.id], /MIRROR_NOT_VERIFIED|intents_guard|version/);
    await tryUpd(pool, "UPDATE booking.intents SET offline_charge_id = '1', version = version + 1 WHERE id = $1", [c.id], /OFFLINE_CHARGE_ID_IMMUTABLE|intents_guard|version/);
  }
  // the owner, with the guard's statement-level view: exact codes (single-column changes inside a rolled-back tx)
  const ownerCode = async (sql, params) => { const x = await db.owner.connect(); try { await x.query("BEGIN"); await x.query("SET LOCAL session_replication_role = origin"); await x.query(sql, params); return null; } catch (e) { return e.message; } finally { await x.query("ROLLBACK").catch(() => {}); x.release(); } };
  assert.match(await ownerCode("UPDATE booking.intents SET settlement_recording_mirrored = NULL WHERE id = $1", [c.id]), /MIRROR_FLAG_IMMUTABLE|version/);
  assert.match(await ownerCode("UPDATE booking.intents SET settlement_recording_mirrored = TRUE WHERE id = $1", [c.id]), /MIRROR_NOT_VERIFIED|version/);
  assert.match(await ownerCode("UPDATE booking.intents SET offline_charge_id = NULL WHERE id = $1", [c.id]), /OFFLINE_CHARGE_ID_IMMUTABLE|intents_recording_mirrored_needs_charge|version/);
  // the fact-derived discriminator: bypass the flag to NULL (SYNTHETIC, replica mode) → the terminal is STILL refused (the recording / offline charge id are facts)
  await synthetic("UPDATE booking.intents SET settlement_recording_mirrored = NULL WHERE id = $1", [c.id]);
  assert.equal((await intentRow(c.id)).m, null);
  const tTerminal = await db.owner.connect();
  try {
    await tTerminal.query("BEGIN");
    await refusal(tTerminal.query("UPDATE booking.intents SET state = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1", [c.id]), /CANCELLATION_NOT_VERIFIED|MIRROR|version|guard/);
  } finally { await tTerminal.query("ROLLBACK").catch(() => {}); tTerminal.release(); }
  await synthetic("UPDATE booking.intents SET settlement_recording_mirrored = FALSE WHERE id = $1", [c.id]);
  // a PRISTINE (0019) cleanup can never carry the flag: NULL→FALSE only on confirmed→test_cleanup_pending
  const p = await capturedUSD();
  const i = await loadIntent(db.app, p.id);
  F.ok(await requestTestCleanup(db.app, p.id, { now: F.at(20), env: ENV, operator: Object.freeze({ approvalRef: "SYNTHETIC-p", attemptId: p.attemptId, authorizedMinor: AMT, capturedMinor: AMT,
    chargeId: p.stripeChargeId, currency: "USD", expectedVersion: i.version, finalTotalMinor: AMT, from: i.from, guests: i.guests, intentId: p.id, listingId: LIST, paymentIntentId: p.piId,
    planHash: "0".repeat(64), reservationId: String(p.reservationId), sessionId: p.sessionId, to: i.to }) }), "pristine request");
  assert.equal((await intentRow(p.id)).m, null, "pristine: NULL");
  assert.match(await ownerCode("UPDATE booking.intents SET settlement_recording_mirrored = FALSE WHERE id = $1", [p.id]), /MIRROR_FLAG_IMMUTABLE|intents_recording_mirrored_needs_charge|version/);
  // the pristine path proceeds to cancelled exactly as 0019 (two legs), untouched by 0021
  F.ok(await cancelLeg(p, 24)); F.ok((await refundLeg(p, 28)).r);
  assert.deepEqual(await intentRow(p.id).then((x) => [x.state, x.rc, x.a, x.m]), ["cancelled", true, true, null]);
  assert.equal((await rows(p.id, MIRROR)).length, 0); assert.equal(await held(p.id), false);
});

test("Q9 suppression least privilege / audit: the app role has no direct pending→superseded path; the owner without the token is refused; a suppression whose audit row is missing is refused at COMMIT (deferred); audit rows are append-only; the token table is RLS-hidden from the app; the API refuses a non-recorded / non-pending target", async () => {
  const c = await recordedUSD();
  await refusal(db.app.query("UPDATE booking.external_operations SET state = 'superseded', updated_at = now() WHERE id = $1", [c.notifyOpId]), /NOTIFY_SUPPRESS_AUTHORITY|permission denied/);
  await refusal(db.owner.query("UPDATE booking.external_operations SET state = 'superseded', updated_at = now() WHERE id = $1", [c.notifyOpId]), /NOTIFY_SUPPRESS_AUTHORITY: no suppression token/);
  // the API itself refuses outside the recorded request transaction (intent confirmed, not test_cleanup_pending)
  await refusal(db.app.query("SELECT booking.suppress_guest_notification($1, 'x')", [c.id]), /NOTIFY_SUPPRESS_REFUSED: INTENT_STATE/);
  assert.deepEqual((await rows(c.id, NOTIFY)).map((o) => o.state), ["pending"]);
  await refusal(db.app.query("SELECT count(*)::int AS n FROM booking.notification_write_authority"), /permission denied/);
  await refusal(db.app.query("INSERT INTO booking.notification_suppressions (operation_id, intent_id, intent_version, reason, suppressed_by, suppressed_at) VALUES ($1, $2, 1, 'TEST_CLEANUP_RECORDED', 'x', now())", [c.notifyOpId, c.id]), /permission denied/);
  // the owner: token + UPDATE without the audit row → refused when the (deferred) constraint trigger fires at COMMIT; nothing persists
  const o = await db.owner.connect();
  try {
    await o.query("BEGIN");
    await o.query("SELECT 1 FROM booking.intents WHERE id = $1 FOR NO KEY UPDATE", [c.id]);
    await o.query("INSERT INTO booking.notification_write_authority (txid, operation_id, action) VALUES (pg_current_xact_id(), $1, 'suppress')", [c.notifyOpId]);
    await refusal(o.query("UPDATE booking.external_operations SET state = 'superseded', updated_at = now() WHERE id = $1", [c.notifyOpId]), /NOTIFY_SUPPRESS_FENCED: only the booking_confirmed row of a recorded TEST cleanup/);
  } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); }
  // a real request, then the audit row is append-only and bound
  F.ok(await request(c));
  await refusal(db.owner.query("UPDATE booking.notification_suppressions SET reason = 'TEST_CLEANUP_RECORDED' WHERE operation_id = $1", [c.notifyOpId]), /append-only|not allowed|reject/i);
  await refusal(db.owner.query("DELETE FROM booking.notification_suppressions WHERE operation_id = $1", [c.notifyOpId]), /append-only|not allowed|reject/i);
  await refusal(db.owner.query("TRUNCATE booking.notification_suppressions"), /append-only|not allowed|reject/i);
  await refusal(db.owner.query("INSERT INTO booking.notification_suppressions (operation_id, intent_id, intent_version, reason, suppressed_by, suppressed_at) VALUES ($1, $2, 1, 'TEST_CLEANUP_RECORDED', 'x', now())", [c.notifyOpId, c.id]), /unique|duplicate/);
  const d = await recordedUSD();
  await refusal(db.owner.query("INSERT INTO booking.notification_suppressions (operation_id, intent_id, intent_version, reason, suppressed_by, suppressed_at) VALUES ($1, $2, 1, 'TEST_CLEANUP_RECORDED', 'x', now())", [d.notifyOpId, d.id]), /NOTIFY_SUPPRESS_AUDIT_UNBOUND/);
  // superseded is terminal for the notification: no transition leaves it (fence), recovery / dispatch ignore it
  await refusal(db.owner.query("UPDATE booking.external_operations SET state = 'pending', updated_at = now() WHERE id = $1", [c.notifyOpId]), /NOTIFY_TRANSITION_REFUSED|not allowed/);
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.external_operations WHERE id = $1 AND state = 'superseded'", [c.notifyOpId])).rows[0].n, 1);
  // the mirror claim fence: a mirror row on a pristine cleanup never exists, and attempt 2 is impossible (one claim ever)
  const e = await bothLegs(await recordedUSD());
  await claimMirror(e);
  await refusal(db.owner.query("UPDATE booking.external_operations SET state = 'pending', lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [e.mirrorOpId]), /not allowed|guard|fence/i);
});

test("Q10 migration: 0021 down restores the 0020 schema exactly (functions incl. the two replaced bodies, constraints, indexes, triggers, columns, grants, policies); up re-applies identically; a USED foundation refuses down honestly", async () => {
  const fresh = await startPostgres(); const admin = new pg.Client({ connectionString: fresh.adminUrl }); await admin.connect();
  try {
    const objects = async () => (await admin.query(`
      SELECT 'fn|' || p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(array_to_string(p.proacl, ','), '') AS o FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      UNION ALL SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'booking'::regnamespace
      UNION ALL SELECT 'idx|' || indexname || '|' || indexdef FROM pg_indexes WHERE schemaname = 'booking'
      UNION ALL SELECT 'trg|' || tgrelid::regclass::text || '|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'booking'::regnamespace)
      UNION ALL SELECT 'col|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable FROM information_schema.columns WHERE table_schema = 'booking'
      UNION ALL SELECT 'tbl|' || relname || '|' || coalesce(array_to_string(relacl, ','), '') || '|' || relrowsecurity::text FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r'
      UNION ALL SELECT 'pol|' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(qual, '') FROM pg_policies WHERE schemaname = 'booking' ORDER BY 1`)).rows.map((r) => r.o);
    assert.equal((await migrateUp(admin, { env: "test", to: 20 })).at(-1), 20);
    const at20 = await objects();
    assert.deepEqual(await migrateUp(admin, { env: "test" }), [21]);
    const at21 = await objects();
    assert.ok(at21.some((x) => x.startsWith("col|intents|settlement_recording_mirrored|boolean|YES")));
    assert.ok(at21.some((x) => x.startsWith("tbl|notification_suppressions|")));
    assert.deepEqual(await migrateDown(admin, { env: "test", to: 20 }), [21]);
    assert.deepEqual(await objects(), at20, "exact restoration");
    assert.deepEqual(await migrateUp(admin, { env: "test" }), [21]);
    assert.deepEqual(await objects(), at21, "idempotent re-apply");
    assert.deepEqual(await migrateUp(admin, { env: "test" }), []);
  } finally { await admin.end(); fresh.stop(); }
  // the shared test database USED the foundation (recorded requests, mirrors, suppressions): down refuses honestly
  const owner = new pg.Client({ connectionString: db.adminUrl }); await owner.connect();
  try { await refusal(migrateDown(owner, { env: "test", to: 20 }), /cannot be rolled back/); }
  finally { await owner.end(); }
  assert.equal((await db.app.query("SELECT count(*)::int AS n FROM booking.notification_suppressions")).rows[0].n > 0, true);
});

// ============================================================================================= ROOT HOLD 5884519489 (F1 / F2 / F3)
test("Q11 (F1) the terminal event is BOUND to the ONE proven mirror: OFFLINE_CHARGE_REFUND_RECORDED carrying another refund id → ok:false TEST_CLEANUP_MIRROR_EVENT_UNBOUND with ZERO writes (pending, flag false, claim held, no ledger, end predicate false); the correct id completes; the DB ledger fence / deferred terminal trigger refuse an unbound entry independently of the repo", async () => {
  const c = await bothLegs(await recordedUSD());
  await claimMirror(c);
  assert.deepEqual((await completeMirror(c)).r, { ok: true, state: "succeeded" });
  const proven = refundIdOf(c); const wrong = String(Number(proven) + 77);
  const snap = async () => [await intentRow(c.id), await ledger(c.id), await held(c.id), (await rows(c.id, MIRROR)).map((o) => [o.state, o.result_ref])];
  const before = await snap();
  const bad = await terminal(c, wrong);
  assert.equal(bad.ok, false, JSON.stringify(bad)); assert.equal(bad.error, "TEST_CLEANUP_MIRROR_EVENT_UNBOUND");
  assert.deepEqual(await snap(), before, "ZERO writes: still test_cleanup_pending / flag false / claim held / ledger unchanged");
  assert.equal(await endOk(c.id), false);
  assert.equal((await terminal(c, c.offlineChargeId)).error, "MIRROR_REFUND_ID_INVALID", "the original's id is refused by the reducer");
  assert.equal((await terminal(c, String(Number(proven) + 1000))).error, "TEST_CLEANUP_MIRROR_EVENT_UNBOUND");
  assert.deepEqual(await snap(), before);
  // the DB alone (owner, rolled back): an unbound ledger entry is refused at the INSERT; a terminal without the bound entry is refused at COMMIT
  const o = await db.owner.connect();
  try {
    await o.query("BEGIN");
    await refusal(o.query("INSERT INTO booking.payment_ledger (intent_id, entry, amount_minor, currency, provider, provider_ref, source, at) VALUES ($1, 'offline_charge_refund_recorded', $2, 'USD', 'hostaway', $3, 'x', now())", [c.id, AMT, wrong]), /MIRROR_LEDGER_UNBOUND/);
    await o.query("ROLLBACK"); await o.query("BEGIN");
    await refusal(o.query("INSERT INTO booking.payment_ledger (intent_id, entry, amount_minor, currency, provider, provider_ref, source, at) VALUES ($1, 'offline_charge_refund_recorded', $2, 'USD', 'hostaway', $3, 'x', now())", [c.id, AMT, proven]), /MIRROR_LEDGER_UNBOUND/, "flag still false: not the terminal transaction");
    await o.query("ROLLBACK"); await o.query("BEGIN");
    await o.query("UPDATE booking.intents SET state = 'cancelled', settlement_recording_mirrored = TRUE, version = version + 1, updated_at = now() WHERE id = $1", [c.id]);
    await refusal(o.query("COMMIT"), /MIRROR_LEDGER_REQUIRED/);
  } finally { await o.query("ROLLBACK").catch(() => {}); o.release(); }
  assert.deepEqual(await snap(), before, "the DB refusals persisted nothing");
  // control: the proven id
  const good = await terminal(c, proven);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.deepEqual((await ledger(c.id)).filter((l) => l.entry === "offline_charge_refund_recorded"), [{ entry: "offline_charge_refund_recorded", amt: String(AMT), currency: "USD", provider: "hostaway", provider_ref: proven }]);
  assert.equal(await endOk(c.id), true); assert.equal(await held(c.id), false);
});

test("Q12 (F2) the other two legs are re-verified from the LATEST persisted facts at mirror claim, dedicated completion and the terminal: a later failed Stripe refund observation / a later found_active reservation observation refuse (row + claim preserved, no attempt); restoration controls admit", async () => {
  const c = await bothLegs(await recordedUSD());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const activeObserved = { listingId: LIST, from: c.stay.from, to: c.stay.to, totalMinor: AMT };
  const mirrorRow = async () => (await rows(c.id, MIRROR)).map((o) => [o.state, o.attempts, o.dispatched_at === null])[0];
  // after create / before claim: a NEW bound refund read says failed → not settled → the claim is refused; the pristine row and the claim stay
  assert.equal(await stripeSettled(c), true); assert.equal(await legsUnsettled(c), null);
  await refundRead(c, c.re, "failed", Date.now() - 5);
  assert.equal(await stripeSettled(c), false, "the latest bound observation decides"); assert.equal(await legsUnsettled(c), "STRIPE_REFUND_NOT_SETTLED");
  await refusal(claimMirror(c), /MIRROR_CLAIM_FENCED: STRIPE_REFUND_NOT_SETTLED/);
  assert.deepEqual(await mirrorRow(), ["pending", 0, true], "no attempt"); assert.ok(await held(c.id));
  assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.rc, x.a, x.m]), ["test_cleanup_pending", true, true, false], "flags only move forward; the intent is untouched");
  // restoration: a newer succeeded observation
  await sleep(15); await refundRead(c, c.re, "succeeded", Date.now() - 5);
  assert.equal(await legsUnsettled(c), null);
  // the reservation leg: a later found_active observation → refused; a later cancelled observation restores
  await sleep(15); await F.reservationStatus(db.app, c.id, String(c.reservationId), "found_active", activeObserved, nowMin());
  assert.equal(await legsUnsettled(c), "RESERVATION_NOT_CANCELLED_LATEST");
  await refusal(claimMirror(c), /MIRROR_CLAIM_FENCED: RESERVATION_NOT_CANCELLED_LATEST/);
  assert.deepEqual(await mirrorRow(), ["pending", 0, true]);
  await sleep(15); await F.reservationStatus(db.app, c.id, String(c.reservationId), "cancelled", {}, nowMin());
  assert.equal(await legsUnsettled(c), null);
  const op = await claimMirror(c);
  assert.deepEqual(await mirrorRow(), ["in_flight", 1, false]);
  // after claim / before completion: a contradiction refuses the dedicated completion; the in_flight row and the claim are preserved
  await sleep(15); await refundRead(c, c.re, "failed", Date.now() - 5);
  const r1 = await completeMirror(c);
  assert.equal(r1.r.ok, false, JSON.stringify(r1.r)); assert.match(String(r1.r.error), /MIRROR_LEGS_UNSETTLED/);
  assert.deepEqual(await mirrorRow(), ["in_flight", 1, false]); assert.ok(await held(c.id));
  assert.equal((await rows(c.id, MIRROR))[0].settled_evidence_id, null);
  await sleep(15); await refundRead(c, c.re, "succeeded", Date.now() - 5);
  assert.deepEqual((await completeMirror(c)).r, { ok: true, state: "succeeded" }, "restoration: the same proof completes");
  // the terminal: a contradiction after the mirror success refuses the terminal (state preserved); restoration admits
  await sleep(15); await refundRead(c, c.re, "failed", Date.now() - 5);
  const t1 = await terminal(c); assert.equal(t1.ok, false); assert.match(String(t1.error), /CANCELLATION_NOT_VERIFIED|AUTHORIZATION_NOT_VERIFIED/);
  assert.deepEqual(await intentRow(c.id).then((x) => [x.state, x.m]), ["test_cleanup_pending", false]); assert.ok(await held(c.id));
  await sleep(15); await refundRead(c, c.re, "succeeded", Date.now() - 5);
  assert.equal((await terminal(c)).ok, true); assert.equal(await endOk(c.id), true);
  // and a contradiction AFTER the terminal does not reopen anything; the end predicate reports it honestly
  await sleep(15); await refundRead(c, c.re, "failed", Date.now() - 5);
  assert.equal((await intentRow(c.id)).state, "cancelled"); assert.equal(await endOk(c.id), false);
  assert.ok(op);
});

test("Q13 (F3) REAL app-role claim_guest_notification race (valid work lease / RR snapshot / hashes; NO trigger bypass): claimant-first (the claimant holds the intent SHARE lock while blocked at the reservation-attempts row; the request waits, then refuses read-only), request-first (snapshot taken, suppression commits, the claim with the still-valid snapshot is NOT_PENDING and claim_notification_work is idle), and concurrent controls (exactly one winner)", async (t) => {
  // preconditions for a QUALIFYING notification (0016 guest_notification_refusal): v1 recipient scope `.invalid`, USD, a v3 PI observation after the
  // capture dispatch showing the capture and NO refund, the proven recording, no refund record, no open case, no unsettled provider op
  const n = () => ++stayN;
  const mk = async () => {
    const c = await recordedUSD(db.app, { guest: { firstName: "Synthia", lastName: "Fixture", email: `guest.q13.${n()}@mv-test.invalid` } });
    await piRead(c, 9, db.app, { refundedMinor: 0 });
    return c;
  };
  const observe = async (sql, params) => {                                                 // R-C1 observation contract (0016)
    const x = await db.app.connect();
    try { await x.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const r = (await x.query(sql, params)).rows[0].r; await x.query("COMMIT"); return r; }
    catch (e) { await x.query("ROLLBACK").catch(() => {}); throw e; } finally { x.release(); }
  };
  const work = async (worker, c) => (await db.app.query("SELECT booking.claim_notification_work($1, $2, $3) AS r", [worker, [LIST], c.id])).rows[0].r;
  const snapshot = (op) => observe("SELECT booking.guest_notification_snapshot($1) AS r", [op]);
  const CONTENT = "1".repeat(64);
  const claim = async (op, worker, s) => (await db.app.query("SELECT booking.claim_guest_notification($1, $2, 'gn-v1', $3, $4, $5) AS r", [op, worker, CONTENT, s.factsHash, s.recipientHash])).rows[0].r;
  const refusalCode = async (op) => (await db.owner.query("SELECT booking.guest_notification_refusal($1) AS r", [op])).rows[0].r;
  // control: the fixture really qualifies and a REAL claim really claims (no race)
  const k = await mk();
  assert.equal(await refusalCode(k.notifyOpId), null, "the notification qualifies at the fence predicate");
  const wk = await work("gn-q13-ctl", k); assert.equal(wk.status, "acquired", JSON.stringify(wk));
  const sk = await snapshot(k.notifyOpId); assert.equal(sk.class, "ELIGIBLE", JSON.stringify(sk));
  const ck = await claim(k.notifyOpId, "gn-q13-ctl", sk); assert.equal(ck.status, "claimed", JSON.stringify(ck));
  assert.deepEqual((await rows(k.id, NOTIFY)).map((o) => [o.state, o.attempts]), [["in_flight", 1]]);
  const rk = await request(k); assert.equal(rk.ok, false, "after a REAL claim the recorded request refuses read-only"); assert.equal((await intentRow(k.id)).state, "confirmed");
  // (a) claimant first, REAL claim: a lock holder (owner, no write) on hostaway_reservation_attempts makes the claimant wait INSIDE gn_lock_bundle
  //     while it already holds intents FOR SHARE; the request then waits at intents FOR NO KEY UPDATE; release → claim commits first → request refuses
  const a = await mk();
  const wa = await work("gn-q13-a", a); assert.equal(wa.status, "acquired", JSON.stringify(wa));
  const sa = await snapshot(a.notifyOpId); assert.equal(sa.class, "ELIGIBLE");
  const hold = await db.owner.connect();
  let claimP, reqP;
  try {
    await hold.query("BEGIN"); await hold.query("SELECT 1 FROM booking.hostaway_reservation_attempts WHERE intent_id = $1 FOR UPDATE", [a.id]);
    claimP = claim(a.notifyOpId, "gn-q13-a", sa);
    await new Promise((r) => setTimeout(r, 400));
    reqP = request(a);
    await new Promise((r) => setTimeout(r, 400));
    const waiting = (await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active'
      AND (query ~ 'claim_guest_notification' OR query ~ 'booking.intents')`)).rows[0].n;
    assert.ok(waiting >= 2, `both sessions wait on locks (${waiting})`);
    await hold.query("COMMIT");
  } finally { await hold.query("ROLLBACK").catch(() => {}); hold.release(); }
  const [ca, ra] = await Promise.all([claimP, reqP]);
  assert.equal(ca.status, "claimed", JSON.stringify(ca));
  assert.equal(ra.ok, false, JSON.stringify(ra)); assert.ok(["TEST_CLEANUP_WORK_LEASE_HELD", "NOTIFY_SUPPRESS_REFUSED"].includes(ra.error), ra.error);
  t.diagnostic(`Q13(a) claimant-first: claim=${ca.status} request=${ra.error}`);
  assert.deepEqual((await rows(a.id, NOTIFY)).map((o) => [o.state, o.attempts]), [["in_flight", 1]]);
  assert.deepEqual(await intentRow(a.id).then((x) => [x.state, x.m]), ["confirmed", null]); assert.equal((await suppressions(a.id)).length, 0);
  // (b) request first, REAL claim after: the claimant's snapshot is taken BEFORE the request commits (a genuine interleaving); the claim with
  //     that still-valid snapshot is NOT_PENDING; claim_notification_work no longer offers the row
  const b = await mk();
  const sb = await snapshot(b.notifyOpId); assert.equal(sb.class, "ELIGIBLE");
  F.ok(await request(b));
  const wb = await work("gn-q13-b", b); assert.equal(wb.status, "idle", JSON.stringify(wb));
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = $2, work_lease_until = now() + interval '120 seconds' WHERE intent_id = $1", [b.id, "gn-q13-b"]);
  const cb = await claim(b.notifyOpId, "gn-q13-b", sb);
  assert.deepEqual(cb, { status: "not_claimable", code: "NOT_PENDING" });
  assert.deepEqual((await rows(b.id, NOTIFY)).map((o) => [o.state, o.attempts]), [["superseded", 0]]); assert.equal((await suppressions(b.id)).length, 1);
  await db.app.query("UPDATE booking.intent_work SET work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [b.id]);
  // (c) concurrent controls: a REAL claim (work → snapshot → claim) racing the request from a barrier, several rounds: exactly one winner each time
  const outcomes = [];
  for (let i = 0; i < 4; i++) {
    const e = await mk();
    const se = await snapshot(e.notifyOpId);
    const go = F.barrier(2);
    const claimant = (async () => { await go(); const w = await work(`gn-q13-c${i}`, e); if (w.status !== "acquired") return { status: "no_work", w }; return claim(e.notifyOpId, `gn-q13-c${i}`, se); })();
    const requester = (async () => { await go(); return request(e); })();
    const [ce, re] = await Promise.all([claimant, requester]);
    const row = (await rows(e.id, NOTIFY))[0]; const ir = await intentRow(e.id);
    const claimWon = ce.status === "claimed"; const requestWon = re.ok === true;
    assert.notEqual(claimWon, requestWon, `exactly one winner: ${JSON.stringify({ ce, re })}`);
    if (claimWon) { assert.deepEqual([row.state, row.attempts, ir.state], ["in_flight", 1, "confirmed"]); }
    else { assert.deepEqual([row.state, row.attempts, ir.state, ce.status], ["superseded", 0, "test_cleanup_pending", ce.status === "no_work" ? "no_work" : "not_claimable"]); }
    outcomes.push(claimWon ? "claim" : "request");
  }
  assert.equal(outcomes.length, 4);
  t.diagnostic(`Q13(c) concurrent winners: ${outcomes.join(",")}`);
});
