// Stage E7.1 — recovery foundation on a throwaway local PostgreSQL with FAKE providers (no Stripe/Hostaway, no network).
// Runtime code runs as mv_booking_app. Covers: the transactional capture claim fence (races, stale attempts, two
// workers, generic claim paths), crash after claim / after read completion / after evidence, lost lease, duplicate
// planning and read re-issue, bounded finders.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations, recordProviderEvidence, requestRead, settleOperationFromEvidence, reportUnknownOutcome, supersedeUnclaimableCreates } from "../../lib/booking-db/operations.js";
import {
  findMissedOutcomes, loadRecoveryFacts, requestRecoveryRead, findOrphanReads, reissueOrphanRead, applyRecoveryPlan, escalateOperatorPlan,
  MAX_RECOVERY_READS, RECOVERY_MAX_BATCH
} from "../../lib/booking-db/recovery.js";
import { planRecovery, RECOVERY_EVENT_ID } from "../../lib/checkout/recovery-plan.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const L = (n) => 810000 + n;
const CAP = "stripe.capture_payment_intent";
const PIREAD = "stripe.retrieve_payment_intent";
const ops = async (id, type) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, type])).rows;
const transitions = async (id, type) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, type]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake Stripe PaymentIntent read result (proof observation shape), bound to the intent and its payment attempt. */
const piObserved = (r, status, over = {}) => ({
  proofVersion: "pi-proof-v2", object: "payment_intent", paymentIntentId: r.piId, accountVerified: true, livemode: false, metadataIntentId: r.id,
  metadataAttemptId: r.attemptId, captureMethod: "manual", status, amountMinor: 576000, amountReceivedMinor: status === "succeeded" ? 576000 : 0,
  amountCapturableMinor: status === "requires_capture" ? 576000 : 0, currency: "MXN",
  latestCharge: { object: "charge", id: `ch_${r.id.slice(0, 8)}`, paymentIntent: r.piId, status: "succeeded", captured: status === "succeeded", amountMinor: 576000,
    amountCapturedMinor: status === "succeeded" ? 576000 : 0, amountRefundedMinor: 0, currency: "MXN", livemode: false }, ...over
});
/** Fake worker: claim one pending read for the intent, complete it, record evidence (optionally crash before evidence). */
async function fakeRead(intentId, opType, minutes, { kind, ref, status, observed, crashBeforeEvidence = false } = {}) {
  const op = await claimNextOperation(db.app, { workerId: "w-read", now: F.at(minutes), intentId, opTypes: [opType] });
  assert.ok(op, `${opType} read claimable`);
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-read", now: F.at(minutes), outcome: { status: "succeeded", resultRef: ref } }), "read done");
  if (crashBeforeEvidence) return { readOpId: op.id };
  const e = F.ok(await recordProviderEvidence(db.app, { readOpId: op.id, kind, externalRef: String(ref), status, observed }), "evidence");
  return { readOpId: op.id, evidenceId: e.id };
}
/** One recovery pass for one operation (test-only orchestration; the library has no runner). */
async function recoverOne(opId, minutes) {
  const facts = await loadRecoveryFacts(db.app, opId);
  const plan = planRecovery({ ...facts, now: F.at(minutes) });
  if (plan.kind === "event") return { plan, res: await applyRecoveryPlan(db.app, plan, { now: F.at(minutes) }) };
  if (plan.kind === "needs_fresh_read") return { plan, res: await requestRecoveryRead(db.app, opId, plan.read, { now: F.at(minutes) }) };
  return { plan };
}
async function waitForLockWaiter(timeoutMs = 3000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const n = await F.count(db.owner, "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (n > 0) return true;
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// (1) transactional capture claim fence

test("fence: a state change committed while a claim waits on the intent lock -> the claim is refused (intent-first)", async () => {
  const r = await F.reserved(db.app, { listingId: L(1) });
  let claimP;
  const res = await applyEvent(db.app, r.id, { type: "ESCALATE", code: "TEST_STATE_CHANGE" }, {
    now: F.at(8), hooks: { beforeCommit: async () => {
      claimP = claimNextOperation(db.app, { workerId: "w1", now: F.at(8), intentId: r.id, opTypes: [CAP] });
      assert.equal(await waitForLockWaiter(), true, "the claim waits on the intent row lock");
    } }
  });
  F.ok(res);
  assert.equal(await claimP, null);
  assert.equal((await ops(r.id, CAP))[0].state, "pending");
  assert.equal((await ops(r.id, CAP))[0].dispatched_at, null);
});

test("fence: a claim holding the intent share lock commits first; the concurrent transition waits and then sees in_flight", async () => {
  const r = await F.reserved(db.app, { listingId: L(2) });
  let evP;
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(8), intentId: r.id, opTypes: [CAP], hooks: {
    afterIntentLock: async () => {
      evP = applyEvent(db.app, r.id, { type: "ESCALATE", code: "TEST_STATE_CHANGE" }, { now: F.at(8) });
      assert.equal(await waitForLockWaiter(), true, "the transition waits for the claim");
    } } });
  assert.ok(op);
  F.ok(await evP);
  assert.equal((await ops(r.id, CAP))[0].state, "in_flight", "claimed before the state change: possibly sent -> must reconcile, never re-queue");
});

test("fence: two workers race for one capture row -> exactly one claim", async () => {
  const r = await F.reserved(db.app, { listingId: L(3) });
  const both = F.barrier(2);
  const [a, b] = await Promise.all(["wa", "wb"].map((w) => claimNextOperation(db.app, { workerId: w, now: F.at(8), intentId: r.id, opTypes: [CAP],
    hooks: { afterIntentLock: both } })));
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.equal((await ops(r.id, CAP))[0].attempts, 1);
});

test("fence: stale or non-current attempts are never claimable, by claimNextOperation or a generic UPDATE (database trigger)", async () => {
  const r = await F.reserved(db.app, { listingId: L(4) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "succeeded", resultRef: r.piId });
  // a stray row for a NON-current attempt (2 while capture_attempts = 1)
  await db.app.query(
    `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts,
       next_attempt_at, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, 'reconcile_first', 'pending', $4, 1, 1, $5, $5, $5)`,
    [r.id, CAP, `stray:${r.id}`, { paymentIntentId: `${r.piId}_x`, attempt: 2, amountMinor: 576000 }, new Date(F.at(8))]);
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(9), intentId: r.id, opTypes: [CAP] }), null);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'x', lease_until = now() WHERE idempotency_key = $1",
    [`stray:${r.id}`]), /CAPTURE_CLAIM_FENCED/);
  // a current-attempt pending row of an intent that left reservation_confirmed is fenced too
  const r2 = await F.reserved(db.app, { listingId: L(5) });
  F.ok(await applyEvent(db.app, r2.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TEST" }, { now: F.at(8) }));
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(9), intentId: r2.id, opTypes: [CAP] }), null);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'in_flight', lease_worker_id = 'x', lease_until = now() WHERE intent_id = $1 AND op_type = $2",
    [r2.id, CAP]), /CAPTURE_CLAIM_FENCED/);
  assert.equal(op.state, "in_flight");
});

// ---------------------------------------------------------------------------------------------
// (2)–(4) crash windows end to end

test("crash after capture claim: lease lost -> unknown; never re-queued; CAPTURE_OUTCOME_UNKNOWN first; full-proof read settles; stale worker applies nothing", async () => {
  const r = await F.reserved(db.app, { listingId: L(10) });
  const op = await claimNextOperation(db.app, { workerId: "w-crash", now: F.at(8), intentId: r.id, opTypes: [CAP] });
  // worker "crashes" after the claim (the capture may or may not have been sent)
  assert.deepEqual((await recoverExpiredOperations(db.app, { now: F.at(10) })).find((x) => x.id === op.id).state, "outcome_unknown");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(11), intentId: r.id, opTypes: [CAP] }), null, "never re-claimed");
  const late = await completeOperation(db.app, op.id, { workerId: "w-crash", now: F.at(11), outcome: { status: "succeeded", resultRef: r.piId } });
  assert.deepEqual([late.ok, late.error, late.lateEvidenceRecorded], [false, "LEASE_LOST", true]);
  assert.equal(await F.state(db.app, r.id), "reservation_confirmed", "the stale worker applied no event");
  // within the grace window the finder leaves it to a live worker
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(11) })).rows.some((x) => x.opId === op.id), false);
  const found = (await findMissedOutcomes(db.app, { now: F.at(13) })).rows.find((x) => x.opId === op.id);
  assert.deepEqual([found.opType, found.state], [CAP, "outcome_unknown"]);
  const s1 = await recoverOne(op.id, 13);
  assert.deepEqual([s1.plan.event.type, s1.plan.event.id], ["CAPTURE_OUTCOME_UNKNOWN", RECOVERY_EVENT_ID.unknown(op.id)]);
  F.ok(s1.res);
  assert.equal(await F.state(db.app, r.id), "capture_unknown");
  // E3 queued the PI read; the planner reuses it instead of creating another
  const s2 = await recoverOne(op.id, 14);
  assert.deepEqual([s2.plan.kind, s2.res.reused], ["needs_fresh_read", true]);
  assert.equal((await ops(r.id, PIREAD)).length, 1);
  await fakeRead(r.id, PIREAD, 15, { kind: "payment_intent", ref: r.piId, status: "succeeded", observed: piObserved(r, "succeeded") });
  const s3 = await recoverOne(op.id, 16);
  assert.equal(s3.plan.event.type, "RECONCILED_CAPTURE_SUCCEEDED");
  F.ok(s3.res);
  assert.equal(await F.state(db.app, r.id), "payment_captured");
  const row = (await ops(r.id, CAP))[0];
  assert.deepEqual([row.state, row.settled_evidence_id !== null], ["succeeded", true]);
  assert.equal((await ops(r.id, CAP)).length, 1, "exactly one capture row ever");
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(30) })).rows.some((x) => x.opId === op.id), false, "handled");
  // replaying the old plans changes nothing
  const again = await applyRecoveryPlan(db.app, s1.plan, { now: F.at(31) });
  assert.equal(again.ok === false ? again.error : "dup", "STALE_PLAN");
  assert.equal(await transitions(r.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
});

test("capture still authorized: settle from evidence then exactly one new capture attempt (current attempt 2); attempt-1 row never claimable", async () => {
  const r = await F.reserved(db.app, { listingId: L(11) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op.id, 9)).res);
  await fakeRead(r.id, PIREAD, 11, { kind: "payment_intent", ref: r.piId, status: "requires_capture", observed: piObserved(r, "requires_capture") });
  const s = await recoverOne(op.id, 12);
  assert.equal(s.plan.event.type, "RECONCILED_STILL_AUTHORIZED");
  F.ok(s.res);
  const caps = await ops(r.id, CAP);
  assert.deepEqual(caps.map((c) => [c.payload.attempt, c.state]), [[1, "failed_definite"], [2, "pending"]]);
  const c2 = await claimNextOperation(db.app, { workerId: "w3", now: F.at(13), intentId: r.id, opTypes: [CAP] });
  assert.equal(c2.payload.attempt, 2);
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(30) })).rows.some((x) => x.opId === op.id), false, "the attempt-1 row is no longer awaited");
});

test("finder: an earlier capture attempt settled through the NORMAL path (no recovery event id) is not awaited once attempt 2 exists", async () => {
  const r = await F.reserved(db.app, { listingId: L(14) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok(await reportUnknownOutcome(db.app, op.id, { now: F.at(9) }));
  const { evidenceId } = await fakeRead(r.id, PIREAD, 11, { kind: "payment_intent", ref: r.piId, status: "requires_capture", observed: piObserved(r, "requires_capture") });
  F.ok(await settleOperationFromEvidence(db.app, op.id, evidenceId));
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_STILL_AUTHORIZED", id: "normal-path-reconcile" }, { now: F.at(12) }));
  const i = await loadIntent(db.app, r.id);
  assert.deepEqual([i.status, i.counters.captureAttempts], ["reservation_confirmed", 2]);
  const rows = (await findMissedOutcomes(db.app, { now: F.at(30) })).rows;
  assert.equal(rows.some((x) => x.opId === op.id), false, "attempt 1 is stale: not returned");
  assert.equal(planRecovery({ ...(await loadRecoveryFacts(db.app, op.id)), now: F.at(30) }).code, "STALE_ATTEMPT");
});

test("crash after evidence, before the event: the finder picks it up; duplicate/concurrent planners apply exactly once", async () => {
  const r = await F.reserved(db.app, { listingId: L(12) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op.id, 9)).res);
  await fakeRead(r.id, PIREAD, 11, { kind: "payment_intent", ref: r.piId, status: "succeeded", observed: piObserved(r, "succeeded") });
  // (crash here: evidence persisted, no event)
  assert.ok((await findMissedOutcomes(db.app, { now: F.at(14) })).rows.some((x) => x.opId === op.id));
  const facts = await loadRecoveryFacts(db.app, op.id);
  const p1 = planRecovery({ ...facts, now: F.at(14) });
  const p2 = planRecovery({ ...facts, now: F.at(14) });
  assert.deepEqual(p1, p2, "planning is deterministic");
  const both = F.barrier(2);
  // both planners pass the early checks and race the settlement; neither may block the other
  const res = await Promise.all([p1, p2].map((p) => applyRecoveryPlan(db.app, p, { now: F.at(14), hooks: { beforeSettle: both } })));
  assert.equal(res.filter((x) => x.ok && !x.duplicate).length, 1, JSON.stringify(res.map((x) => x.error || x.duplicate)));
  assert.equal(res.filter((x) => x.ok && x.duplicate).length, 1, "the loser sees the same evidence and de-duplicates");
  assert.equal(await transitions(r.id, "RECONCILED_CAPTURE_SUCCEEDED"), 1);
  assert.equal(await F.state(db.app, r.id), "payment_captured");
});

test("stale plan: the intent moved on (same state, newer version) -> STALE_PLAN, nothing applied, nothing settled", async () => {
  const r = await F.reserved(db.app, { listingId: L(13) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op.id, 9)).res);
  await fakeRead(r.id, PIREAD, 11, { kind: "payment_intent", ref: r.piId, status: "requires_capture", observed: piObserved(r, "requires_capture") });
  const plan = planRecovery({ ...(await loadRecoveryFacts(db.app, op.id)), now: F.at(12) });
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILIATION_INCONCLUSIVE", id: "other-worker", subject: "payment" }, { now: F.at(12) }));
  assert.equal((await applyRecoveryPlan(db.app, plan, { now: F.at(12) })).error, "STALE_PLAN");
  assert.equal((await ops(r.id, CAP))[0].state, "outcome_unknown", "not settled from a stale plan");
  // the inside-transaction check: version moves between the early check and the event transaction
  const plan2 = planRecovery({ ...(await loadRecoveryFacts(db.app, op.id)), now: F.at(13) });
  const res = await applyRecoveryPlan(db.app, plan2, { now: F.at(13), hooks: { afterSettle: async () => {
    F.ok(await applyEvent(db.app, r.id, { type: "RECONCILIATION_INCONCLUSIVE", id: "other-worker-2", subject: "payment" }, { now: F.at(13) }));
  } } });
  assert.equal(res.ok, false);
  assert.equal(await transitions(r.id, "RECONCILED_STILL_AUTHORIZED"), 0);
});

test("crash after create claim: unknown, never a second create; reconciled only with by-ref + by-id proof", async () => {
  const d = await F.dispatched(db.app, { listingId: L(20) });
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  await recoverExpiredOperations(db.app, { now: F.at(8) });
  assert.equal((await ops(d.id, "hostaway.create_reservation"))[0].state, "outcome_unknown");
  const s1 = await recoverOne(op.id, 9);
  assert.equal(s1.plan.event.type, "RESERVATION_OUTCOME_UNKNOWN");
  F.ok(s1.res);
  assert.equal(await F.state(db.app, d.id), "reservation_unknown");
  const intent = await loadIntent(db.app, d.id);
  const rid = "990020";
  const stay = { listingId: L(20), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000 };
  await fakeRead(d.id, "hostaway.lookup_reservation", 10, { kind: "hostaway_reservation", ref: rid, status: "found_active",
    observed: { bookingRef: intent.ref, matchCount: 1, reservationId: rid, currency: "MXN", ...stay } });
  const s2 = await recoverOne(op.id, 11);
  assert.deepEqual(s2.plan.read, { opType: "hostaway.retrieve_reservation", ref: rid });
  F.ok(s2.res);
  await fakeRead(d.id, "hostaway.retrieve_reservation", 12, { kind: "hostaway_reservation", ref: rid, status: "found_active",
    observed: { reservationId: rid, currency: "MXN", ...stay } });
  const s3 = await recoverOne(op.id, 13);
  assert.equal(s3.plan.event.type, "RECONCILED_RESERVATION_FOUND");
  F.ok(s3.res);
  assert.equal(await F.state(db.app, d.id), "reservation_confirmed");
  assert.equal((await ops(d.id, "hostaway.create_reservation")).length, 1, "one create row, ever");
});

test("void leg after a definite capture refusal: unknown -> PI read -> settle + VOID_SUCCEEDED (database void guard satisfied)", async () => {
  const d = await F.reserved(db.app, { listingId: L(21) });
  await F.runOp(db.app, d.id, CAP, 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, d.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  const { op } = await F.runOp(db.app, d.id, "stripe.void_payment_intent", 9, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  const s0 = await recoverOne(op.id, 10);
  assert.equal(s0.plan.event.type, "VOID_OUTCOME_UNKNOWN");
  F.ok(s0.res);
  await fakeRead(d.id, PIREAD, 12, { kind: "payment_intent", ref: d.piId, status: "canceled", observed: piObserved(d, "canceled") });
  const s = await recoverOne(op.id, 13);
  assert.equal(s.plan.event.type, "VOID_SUCCEEDED");
  F.ok(s.res);
  const i = await loadIntent(db.app, d.id);
  assert.deepEqual([i.status, i.settlement.authorizationSettled, i.settlement.reservationCancelled], ["capture_failed", true, false]);
  assert.equal((await ops(d.id, "stripe.void_payment_intent")).length, 1, "no second void");
});

test("handled = op-outcome applied: a VOID_FAILED leg stays in capture_failed but the row is not returned again", async () => {
  const d = await F.reserved(db.app, { listingId: L(22) });
  await F.runOp(db.app, d.id, CAP, 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, d.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  const { op } = await F.runOp(db.app, d.id, "stripe.void_payment_intent", 9, { status: "failed_definite", errorCode: "PAYMENT_INTENT_UNEXPECTED_STATE" });
  assert.ok((await findMissedOutcomes(db.app, { now: F.at(12) })).rows.some((x) => x.opId === op.id));
  const s = await recoverOne(op.id, 12);
  assert.equal(s.plan.event.type, "VOID_FAILED");
  F.ok(s.res);
  assert.equal(await F.state(db.app, d.id), "capture_failed");
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(20) })).rows.some((x) => x.opId === op.id), false);
});

test("crash after read completion (no evidence): one deduplicated re-issue; the orphan stays as audit; values never reconstructed", async () => {
  const r = await F.reserved(db.app, { listingId: L(30) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op.id, 9)).res);
  const { readOpId } = await fakeRead(r.id, PIREAD, 11, { ref: r.piId, crashBeforeEvidence: true });
  assert.equal((await findOrphanReads(db.app, { now: F.at(12) })).some((o) => o.readOpId === readOpId), false, "grace");
  assert.ok((await findOrphanReads(db.app, { now: F.at(14) })).some((o) => o.readOpId === readOpId));
  // the planner sees no evidence for the succeeded read: it asks for a read, never infers
  assert.equal((await recoverOne(op.id, 14)).plan.kind, "needs_fresh_read");
  const reads = await ops(r.id, PIREAD);
  // two concurrent re-issuers: exactly one new read
  const rs = await Promise.all([reissueOrphanRead(db.app, readOpId, { now: F.at(15) }), reissueOrphanRead(db.app, readOpId, { now: F.at(15) })]);
  const after = await ops(r.id, PIREAD);
  assert.ok(rs.filter((x) => x.ok).length <= 1);
  assert.equal(after.filter((o) => o.state === "pending").length, 1, "one open read");
  assert.ok(after.length <= reads.length + 1);
  assert.equal((await findOrphanReads(db.app, { now: F.at(16) })).some((o) => o.readOpId === readOpId), false, "superseded once re-issued");
  const orphan = after.find((o) => o.id === readOpId);
  assert.deepEqual([orphan.state, await F.count(db.app, "SELECT count(*) AS n FROM booking.provider_evidence WHERE read_operation_id = $1", [readOpId])], ["succeeded", 0]);
  // the new read completes with evidence -> recovery proceeds
  await fakeRead(r.id, PIREAD, 17, { kind: "payment_intent", ref: r.piId, status: "canceled", observed: piObserved(r, "canceled") });
  const s = await recoverOne(op.id, 18);
  assert.equal(s.plan.event.type, "RECONCILED_AUTHORIZATION_GONE");
  F.ok(s.res);
  assert.equal(await F.state(db.app, r.id), "capture_failed");
  const withEvidence = (await ops(r.id, PIREAD)).filter((o) => o.state === "succeeded" && o.id !== readOpId);
  const orphans = await findOrphanReads(db.app, { now: F.at(60) });
  for (const o of withEvidence) assert.equal(orphans.some((x) => x.readOpId === o.id), false, "a read with evidence is never an orphan");
});

test("re-issue depth is bounded", async () => {
  const r = await F.reserved(db.app, { listingId: L(31) });
  let readOpId = await requestRead(db.app, r.id, PIREAD, r.piId, { now: F.at(8) });
  const res = [];
  for (let k = 0; k < 4; k++) {
    const op = await claimNextOperation(db.app, { workerId: "w", now: F.at(9 + 3 * k), opId: readOpId });
    F.ok(await completeOperation(db.app, op.id, { workerId: "w", now: F.at(9 + 3 * k), outcome: { status: "succeeded" } }));
    const x = await reissueOrphanRead(db.app, readOpId, { now: F.at(12 + 3 * k) });
    res.push(x.ok ? "ok" : x.error);
    if (!x.ok) break;
    readOpId = x.readOpId;
  }
  assert.deepEqual(res, ["ok", "ok", "ok", "REISSUE_DEPTH_EXHAUSTED"]);
});

test("recovery reads: an open read is reused; at most MAX_RECOVERY_READS per (operation, read, ref); concurrent requests insert one", async () => {
  const r = await F.reserved(db.app, { listingId: L(32) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "succeeded", resultRef: r.piId });
  const read = { opType: PIREAD, ref: r.piId };
  const out = [];
  for (let k = 0; k < MAX_RECOVERY_READS + 1; k++) {
    const [a, b] = await Promise.all([requestRecoveryRead(db.app, op.id, read, { now: F.at(10 + k) }), requestRecoveryRead(db.app, op.id, read, { now: F.at(10 + k) })]);
    out.push([a.ok ? "ok" : a.error, b.ok ? "ok" : b.error]);
    assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending'", [r.id, PIREAD]),
      k < MAX_RECOVERY_READS ? 1 : 0);
    const p = (await ops(r.id, PIREAD)).find((o) => o.state === "pending");
    if (p) { const c = await claimNextOperation(db.app, { workerId: "w", now: F.at(10 + k), opId: p.id }); F.ok(await completeOperation(db.app, c.id, { workerId: "w", now: F.at(10 + k), outcome: { status: "succeeded" } })); }
  }
  assert.deepEqual(out.at(-1), ["RECOVERY_READS_EXHAUSTED", "RECOVERY_READS_EXHAUSTED"]);
  assert.equal((await ops(r.id, PIREAD)).length, MAX_RECOVERY_READS);
});

test("finder: bounded, keyset-paginated, excludes handled ops and intents that no longer await them; read-only", async () => {
  const ids = [];
  for (let k = 0; k < 3; k++) {
    const r = await F.reserved(db.app, { listingId: L(40 + k) });
    ids.push((await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" })).op.id);
  }
  const before = await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations");
  const p1 = await findMissedOutcomes(db.app, { now: F.at(100), limit: 1 });
  assert.equal(p1.rows.length, 1);
  const seen = [...p1.rows];
  let next = p1.next;
  while (next) { const p = await findMissedOutcomes(db.app, { now: F.at(100), limit: 1, after: next }); seen.push(...p.rows); next = p.next; }
  for (const id of ids) assert.equal(seen.filter((x) => x.opId === id).length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations"), before, "the finder writes nothing");
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(100), limit: 10_000 })).rows.length <= RECOVERY_MAX_BATCH, true);
  // escalate one (operator path) -> no longer awaited
  F.ok(await escalateOperatorPlan(db.app, ids[0], "PLANNED_EVENT_REJECTED:TEST", { now: F.at(100) }));
  assert.equal((await findMissedOutcomes(db.app, { now: F.at(101), limit: 100 })).rows.some((x) => x.opId === ids[0]), false);
  // handled by its outcome event -> excluded even though the row is still outcome_unknown
  F.ok((await recoverOne(ids[1], 101)).res); // CAPTURE_OUTCOME_UNKNOWN: still awaited (capture_unknown)
  assert.ok((await findMissedOutcomes(db.app, { now: F.at(104) })).rows.some((x) => x.opId === ids[1]));
});

// ---------------------------------------------------------------------------------------------
// root corrections (2026-11-02 review of 1053f81)

test("root (1): after an inconclusive lookup, the recovery read uses the booking ref, never a provider-returned id (actual payload)", async () => {
  const d = await F.dispatched(db.app, { listingId: L(50) });
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  await recoverExpiredOperations(db.app, { now: F.at(8) });
  F.ok((await recoverOne(op.id, 9)).res);                      // RESERVATION_OUTCOME_UNKNOWN -> E3 queues a lookup by ref
  const intent = await loadIntent(db.app, d.id);
  // fake lookup: not found, recorded with some provider value as externalRef
  await fakeRead(d.id, "hostaway.lookup_reservation", 10, { kind: "hostaway_reservation", ref: "7001", status: "not_found",
    observed: { bookingRef: intent.ref, matchCount: 0 } });
  const s1 = await recoverOne(op.id, 11);
  assert.equal(s1.plan.event.type, "RECONCILIATION_INCONCLUSIVE");
  F.ok(s1.res);
  // E3 queued another lookup; the planner reuses it (its payload is the booking ref)
  const s2 = await recoverOne(op.id, 12);
  assert.deepEqual([s2.plan.read, s2.res.reused], [{ opType: "hostaway.lookup_reservation", ref: intent.ref }, true]);
  // that read completes WITHOUT evidence (crash): the planner asks again and requestRecoveryRead INSERTS a new read
  // every queued lookup (E3's own, all with the booking ref) completes WITHOUT evidence (crash)
  for (let c; (c = await claimNextOperation(db.app, { workerId: "w-read", now: F.at(13), intentId: d.id, opTypes: ["hostaway.lookup_reservation"] }));) {
    assert.deepEqual(c.payload, { ref: intent.ref });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w-read", now: F.at(13), outcome: { status: "succeeded", resultRef: "7001" } }));
  }
  const s3 = await recoverOne(op.id, 14);
  assert.equal(s3.res.reused, false);
  const row = (await db.app.query("SELECT payload, idempotency_key FROM booking.external_operations WHERE id = $1", [s3.res.readOpId])).rows[0];
  assert.deepEqual(row.payload, { ref: intent.ref });
  assert.equal(row.idempotency_key, `rr:${op.id}:hostaway.lookup_reservation:${intent.ref}:1`);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.lookup_reservation' AND payload ->> 'ref' <> $2",
    [d.id, intent.ref]), 0, "no lookup was ever requested by a returned id");
});

test("root (2): a provider-returned id already persisted for the create (attempts row) that differs from the proven id -> ESCALATE conflict", async () => {
  const d = await F.dispatched(db.app, { listingId: L(51) });
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  const stay = { listingId: L(51), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000 };
  await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: { reservationId: "9999", ...stay } }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded" } }));   // no resultRef
  const intent = await loadIntent(db.app, d.id);
  await requestRead(db.app, d.id, "hostaway.lookup_reservation", intent.ref, { now: F.at(10) });
  await fakeRead(d.id, "hostaway.lookup_reservation", 10, { kind: "hostaway_reservation", ref: "7001", status: "found_active",
    observed: { bookingRef: intent.ref, matchCount: 1, reservationId: "7001", currency: "MXN", ...stay } });
  const facts = await loadRecoveryFacts(db.app, op.id);
  assert.deepEqual(facts.knownReservationIds, ["9999"]);
  const p = planRecovery({ ...facts, now: F.at(11) });
  assert.deepEqual([p.event.type, p.event.code], ["ESCALATE", "RESERVATION_ID_CONFLICT"]);
  F.ok(await applyRecoveryPlan(db.app, p, { now: F.at(11) }));
  assert.equal(await F.state(db.app, d.id), "reconciliation_required");
});

test("root (5): equal-timestamp orphan reads of one selector never supersede each other; exactly one is re-issued", async () => {
  const r = await F.reserved(db.app, { listingId: L(52) });
  const ids = [await requestRead(db.app, r.id, PIREAD, r.piId, { now: F.at(20) }), await requestRead(db.app, r.id, PIREAD, r.piId, { now: F.at(20) })];
  for (const id of ids) {
    const c = await claimNextOperation(db.app, { workerId: "w", now: F.at(20), opId: id });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w", now: F.at(20), outcome: { status: "succeeded" } }));
  }
  assert.equal(await F.count(db.app, "SELECT count(DISTINCT created_at) AS n FROM booking.external_operations WHERE id = ANY($1)", [ids]), 1, "identical timestamps");
  const last = [...ids].sort().at(-1);
  const found = (await findOrphanReads(db.app, { now: F.at(30) })).filter((o) => ids.includes(o.readOpId)).map((o) => o.readOpId);
  assert.deepEqual(found, [last], "exactly the last in (created_at, id) order");
  const first = ids.find((x) => x !== last);
  assert.equal((await reissueOrphanRead(db.app, first, { now: F.at(30) })).error, "NOT_AN_ORPHAN");
  const re = await Promise.all([reissueOrphanRead(db.app, last, { now: F.at(20), graceMs: 0 }), reissueOrphanRead(db.app, last, { now: F.at(20), graceMs: 0 })]);  // same instant as the orphans
  assert.equal(re.filter((x) => x.ok).length, 1);
  assert.equal((await findOrphanReads(db.app, { now: F.at(30) })).filter((o) => ids.includes(o.readOpId)).length, 0, "re-issued: none left, even at an equal timestamp");
  assert.equal((await ops(r.id, PIREAD)).length, 3);
});

test("root (5): a re-issued read supersedes its orphan even when a skewed worker clock stamps it EARLIER", async () => {
  const r = await F.reserved(db.app, { listingId: L(55) });
  const id = await requestRead(db.app, r.id, PIREAD, r.piId, { now: F.at(20) });
  const c = await claimNextOperation(db.app, { workerId: "w", now: F.at(20), opId: id });
  F.ok(await completeOperation(db.app, c.id, { workerId: "w", now: F.at(20), outcome: { status: "succeeded" } }));
  // a re-issuer whose clock runs 1 min behind (negative grace stands in for the skew): its read is stamped at(19)
  const re = await reissueOrphanRead(db.app, id, { now: F.at(19), graceMs: -2 * F.MIN });
  F.ok(re);
  assert.ok((await ops(r.id, PIREAD)).find((o) => o.id === re.readOpId).created_at < (await ops(r.id, PIREAD)).find((o) => o.id === id).created_at);
  assert.equal((await findOrphanReads(db.app, { now: F.at(30) })).some((o) => o.readOpId === id), false, "never re-issued twice");
  assert.equal((await reissueOrphanRead(db.app, id, { now: F.at(30) })).error, "NOT_AN_ORPHAN");
});

test("root (6): a claim never locks another intent's rows; a paused transition on intent B does not block a claim on intent A", async () => {
  const a = await F.reserved(db.app, { listingId: L(53) });
  const b = await F.dispatched(db.app, { listingId: L(54) });                // B: pending create, E3 lease expires at(8)
  let release; const paused = new Promise((r) => { release = r; });
  let claimed = null; let claimMs = null;
  const tB = applyEvent(db.app, b.id, { type: "RECOVER_INTERRUPTED" }, { now: F.at(10), hooks: { beforeCommit: async () => {
    // B holds its intent row and has superseded its create row (uncommitted)
    const t0 = Date.now();
    claimed = await claimNextOperation(db.app, { workerId: "wa", now: F.at(10) , intentId: a.id });
    claimMs = Date.now() - t0;
    release();
  } } });
  await paused;
  F.ok(await tB);
  assert.ok(claimed && claimed.intent_id === a.id, "A's operation claimed while B was mid-transaction");
  assert.ok(claimMs < 2000, `claim not blocked by B (${claimMs} ms)`);
  assert.equal((await ops(b.id, "hostaway.create_reservation"))[0].state, "superseded");
});

test("root (6): claim vs transition on the SAME intent with an expired pending create: no deadlock in either order", async () => {
  for (let k = 0; k < 8; k++) {
    const d = await F.dispatched(db.app, { listingId: L(60 + k) });         // pending lookup read + pending create, lease expires at(8)
    const [c, t] = await Promise.allSettled([
      claimNextOperation(db.app, { workerId: `w${k}`, now: F.at(10), intentId: d.id }),
      applyEvent(db.app, d.id, { type: "RECOVER_INTERRUPTED" }, { now: F.at(10) })
    ]);
    assert.equal(c.status, "fulfilled", String(c.reason));
    assert.equal(t.status, "fulfilled", String(t.reason));
    F.ok(t.value);
    assert.notEqual(c.value?.op_type, "hostaway.create_reservation", "an expired create is never claimed");
    assert.equal((await ops(d.id, "hostaway.create_reservation"))[0].state, "superseded");
  }
  // deterministic order: the transition holds the intent; the claim waits on the intent lock (intent first), then proceeds
  const d = await F.dispatched(db.app, { listingId: L(70) });
  let claimP;
  F.ok(await applyEvent(db.app, d.id, { type: "RECOVER_INTERRUPTED" }, { now: F.at(10), hooks: { beforeCommit: async () => {
    claimP = claimNextOperation(db.app, { workerId: "wz", now: F.at(10), intentId: d.id });
    assert.equal(await waitForLockWaiter(), true);
  } } }));
  const c = await claimP;
  assert.ok(c === null || c.op_type === "hostaway.lookup_reservation");
});

test("root (6): supersedeUnclaimableCreates retires only never-sent, unclaimable creates (intent first, bounded)", async () => {
  const stale = await F.dispatched(db.app, { listingId: L(71) });           // lease until at(8)
  const live = await F.dispatched(db.app, { listingId: L(72) });
  assert.deepEqual((await supersedeUnclaimableCreates(db.app, { now: F.at(7) })).filter((x) => [stale.createOpId, live.createOpId].includes(x)), []);
  const done = await supersedeUnclaimableCreates(db.app, { now: F.at(9) });
  assert.ok(done.includes(stale.createOpId) && done.includes(live.createOpId));
  assert.deepEqual((await supersedeUnclaimableCreates(db.app, { now: F.at(9) })).filter((x) => [stale.createOpId, live.createOpId].includes(x)), []);
  // a CLAIMED (possibly sent) create is never superseded
  const sent = await F.dispatched(db.app, { listingId: L(73) });
  await F.claimOp(db.app, sent.id, "hostaway.create_reservation", F.at(6));
  await supersedeUnclaimableCreates(db.app, { now: F.at(30) });
  assert.equal((await ops(sent.id, "hostaway.create_reservation"))[0].state, "in_flight");
});

test("M27 / E7.1a: settled evidence cannot be swapped (0008), and applyRecoveryPlan's own in-transaction check is kept as defence in depth", async () => {
  const r = await F.reserved(db.app, { listingId: L(74) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op.id, 9)).res);
  await fakeRead(r.id, PIREAD, 11, { kind: "payment_intent", ref: r.piId, status: "requires_capture", observed: piObserved(r, "requires_capture") });
  const other = await F.piStatus(db.app, r.id, r.piId, "requires_capture", piObserved(r, "requires_capture"), 12);
  const swapTo = async (plan) => (plan.settle === other
    ? (await db.app.query("SELECT id FROM booking.provider_evidence WHERE intent_id = $1 AND id <> $2 LIMIT 1", [r.id, other])).rows[0].id : other);
  const TRG = "zz_external_operations_settled_evidence_immutable";
  // (a) with 0008: the swap itself is refused by the database for the runtime role
  const plan = planRecovery({ ...(await loadRecoveryFacts(db.app, op.id)), now: F.at(13) });
  assert.equal(plan.event.type, "RECONCILED_STILL_AUTHORIZED");
  let refused = null;
  const resA = await applyRecoveryPlan(db.app, plan, { now: F.at(13), hooks: { afterSettle: async () => {
    refused = await db.app.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [op.id, await swapTo(plan)]).then(() => null, (e) => e.message);
  } } });
  assert.match(String(refused), /SETTLED_EVIDENCE_IMMUTABLE/);
  F.ok(resA);
  assert.equal(await transitions(r.id, "RECONCILED_STILL_AUTHORIZED"), 1);
  // (b) defence in depth: on a database WITHOUT the 0008 guard (owner disables only that trigger, for this case), the
  //     planner-side in-transaction check still refuses a plan whose cited evidence was swapped
  const r2 = await F.reserved(db.app, { listingId: L(75) });
  const { op: op2 } = await F.runOp(db.app, r2.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok((await recoverOne(op2.id, 9)).res);
  await fakeRead(r2.id, PIREAD, 11, { kind: "payment_intent", ref: r2.piId, status: "requires_capture", observed: piObserved(r2, "requires_capture") });
  const other2 = await F.piStatus(db.app, r2.id, r2.piId, "requires_capture", piObserved(r2, "requires_capture"), 12);
  const plan2 = planRecovery({ ...(await loadRecoveryFacts(db.app, op2.id)), now: F.at(13) });
  const swap2 = plan2.settle === other2
    ? (await db.app.query("SELECT id FROM booking.provider_evidence WHERE intent_id = $1 AND id <> $2 LIMIT 1", [r2.id, other2])).rows[0].id : other2;
  let resB;
  try {
    resB = await applyRecoveryPlan(db.app, plan2, { now: F.at(13), hooks: { afterSettle: async () => {
      await db.owner.query(`ALTER TABLE booking.external_operations DISABLE TRIGGER ${TRG}`);
      await db.app.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [op2.id, swap2]);
    } } });
  } finally {
    await db.owner.query(`ALTER TABLE booking.external_operations ENABLE TRIGGER ${TRG}`);
  }
  assert.deepEqual([resB.ok, resB.error], [false, "STALE_PLAN"]);
  assert.equal(await transitions(r2.id, "RECONCILED_STILL_AUTHORIZED"), 0);
  assert.equal((await db.owner.query("SELECT tgenabled FROM pg_trigger WHERE tgname = $1", [TRG])).rows[0].tgenabled, "O", "guard re-enabled");
});
