// Stage E3.2 — failed-capture recovery: E3 state machine + database + outbox agree.
// Throwaway local PostgreSQL; Stripe/Hostaway results are mocked; runtime code runs as mv_booking_app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, claimReleaseBlockers } from "../../db/lib/repo.js";
import {
  claimNextOperation, completeOperation, recoverExpiredOperations, settleOperationFromEvidence, reportUnknownOutcome
} from "../../db/lib/operations.js";
import { captureKey, voidKey } from "../../lib/checkout/intent-state.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const L = (n) => 800000 + n;
const CAP = ["stripe.capture_payment_intent"];
const VOID = ["stripe.void_payment_intent"];
const CANCEL = ["hostaway.cancel_reservation"];
const active = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id]);
const ops = async (id, type) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY source_version", [id, type])).rows;
const capFailed = async (listingId) => {
  const r = await F.reserved(db.app, { listingId });
  await F.runOp(db.app, r.id, CAP[0], 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  return r;
};

test("definite failure: E3 emits exactly one cancel + one void (+alert); both legs start unsettled; dates protected", async () => {
  const r = await capFailed(L(1));
  const i = await loadIntent(db.app, r.id);
  assert.deepEqual([i.status, i.settlement], ["capture_failed", { reservationCancelled: false, authorizationSettled: false }]);
  assert.equal((await ops(r.id, VOID[0])).length, 1);
  assert.equal((await ops(r.id, CANCEL[0])).length, 1);
  const v = (await ops(r.id, VOID[0]))[0];
  assert.deepEqual([v.retry_class, v.max_attempts, v.payload.providerIdempotencyKey], ["reconcile_first", 1, voidKey(r.id, r.piId)]);
  assert.equal(await active(r.id), 1);
  // a definite refusal must carry a real provider error code — a timeout is never "definite"
  const r2 = await F.reserved(db.app, { listingId: L(2) });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(8), intentId: r2.id, opTypes: CAP });
  assert.equal((await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(8), outcome: { status: "failed_definite", errorCode: "TIMEOUT" } })).error,
    "AMBIGUOUS_RESULT_NOT_DEFINITE");
  assert.equal((await applyEvent(db.app, r2.id, { type: "CAPTURE_FAILED", code: "TIMEOUT" }, { now: F.at(8) })).error, "NOT_DEFINITE");
});

test("ambiguous capture: no cancel, no void, no second capture until an authoritative Stripe read settles the first", async () => {
  const r = await F.reserved(db.app, { listingId: L(3) });
  const { op } = await F.runOp(db.app, r.id, CAP[0], 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  assert.equal((await ops(r.id, CAP[0]))[0].state, "outcome_unknown");
  const u = F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(8) }));
  assert.deepEqual(u.operations.map((o) => o.opType), ["stripe.retrieve_payment_intent"]);
  assert.equal((await ops(r.id, CANCEL[0])).length + (await ops(r.id, VOID[0])).length, 0);
  // jumping ahead to a retry while the first capture is unresolved is refused by the database
  assert.equal((await applyEvent(db.app, r.id, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: F.at(9) })).error, "PRIOR_PROVIDER_WRITE_UNRESOLVED");
  // runtime cannot settle it by hand, a too-early read is refused, and the row is never re-claimable
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'failed_definite' WHERE id = $1", [op.id]), /OWNER_RESOLUTION_REQUIRED/);
  const early = await F.piStatus(db.app, r.id, r.piId, "requires_capture", {}, 9);
  assert.equal((await settleOperationFromEvidence(db.app, op.id, early)).error, "EVIDENCE_TOO_EARLY");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(60), intentId: r.id, opTypes: CAP }), null);
  // authoritative read: still authorized -> first attempt settled as not applied -> exactly one new capture, own key
  const ev = await F.piStatus(db.app, r.id, r.piId, "requires_capture", {}, 12);
  assert.deepEqual(F.ok(await settleOperationFromEvidence(db.app, op.id, ev)).state, "failed_definite");
  const retry = F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: F.at(12) }));
  const caps = await ops(r.id, CAP[0]);
  assert.equal(caps.length, 2);
  assert.equal(caps[1].payload.providerIdempotencyKey, captureKey(r.id, r.piId, 2));
  assert.equal(retry.intent.counters.captureAttempts, 2);
});

test("ambiguous capture that actually succeeded: read settles it -> paid booking, no recovery actions at all", async () => {
  const r = await F.reserved(db.app, { listingId: L(4) });
  const { op } = await F.runOp(db.app, r.id, CAP[0], 8, { status: "outcome_unknown", errorCode: "HTTP_5XX" });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_OUTCOME_UNKNOWN", code: "HTTP_5XX" }, { now: F.at(8) }));
  const ev = await F.piStatus(db.app, r.id, r.piId, "succeeded", { amountReceivedMinor: 576000 }, 12);
  assert.equal(F.ok(await settleOperationFromEvidence(db.app, op.id, ev)).state, "succeeded");
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: F.at(12) }));
  assert.equal(await F.state(db.app, r.id), "payment_captured");
  assert.equal((await ops(r.id, CANCEL[0])).length + (await ops(r.id, VOID[0])).length, 0);
});

test("cancellation pending: an ambiguous cancel is read first; still active -> one new cancel; then verified", async () => {
  const r = await capFailed(L(5));
  const { op } = await F.runOp(db.app, r.id, CANCEL[0], 9, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  const u = F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCEL_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(9) }));
  assert.deepEqual(u.operations.map((o) => o.opType), ["hostaway.retrieve_reservation"]);
  assert.equal((await applyEvent(db.app, r.id, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, { now: F.at(10) })).error, "PRIOR_PROVIDER_WRITE_UNRESOLVED");
  const stillActive = await F.reservationStatus(db.app, r.id, String(r.reservationId), "found_active",
    { listingId: L(5), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000 }, 12);
  assert.equal(F.ok(await settleOperationFromEvidence(db.app, op.id, stillActive)).state, "failed_definite");
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_RESERVATION_STILL_ACTIVE" }, { now: F.at(12) }));
  const cancels = await ops(r.id, CANCEL[0]);
  assert.deepEqual(cancels.map((c) => c.idempotency_key.split(":").pop()), ["1", "2"]);
  await F.runOp(db.app, r.id, CANCEL[0], 13);
  await F.reservationStatus(db.app, r.id, String(r.reservationId), "cancelled", {}, 14);
  F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(14) }));
  const i = await loadIntent(db.app, r.id);
  assert.deepEqual([i.status, i.settlement], ["capture_failed", { reservationCancelled: true, authorizationSettled: false }]);
  assert.equal(await active(r.id), 1, "void still pending");
});

test("void pending: an ambiguous void is read first; verified-gone authorization settles the leg; dates released only then", async () => {
  const r = await capFailed(L(6));
  await F.runOp(db.app, r.id, CANCEL[0], 9);
  await F.reservationStatus(db.app, r.id, String(r.reservationId), "cancelled", {}, 9);
  F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(9) }));
  const { op } = await F.runOp(db.app, r.id, VOID[0], 10, { status: "outcome_unknown", errorCode: "NETWORK_ERROR" });
  F.ok(await applyEvent(db.app, r.id, { type: "VOID_OUTCOME_UNKNOWN", code: "NETWORK_ERROR" }, { now: F.at(10) }));
  assert.equal(await active(r.id), 1);
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(100), intentId: r.id, opTypes: VOID }), null, "no blind re-void");
  // the leg cannot be marked settled on an unverified claim
  assert.equal((await applyEvent(db.app, r.id, { type: "RECONCILED_AUTHORIZATION_GONE" }, { now: F.at(11) })).error, "AUTHORIZATION_NOT_VERIFIED_SETTLED");
  const gone = await F.piStatus(db.app, r.id, r.piId, "canceled", {}, 13);
  assert.equal(F.ok(await settleOperationFromEvidence(db.app, op.id, gone)).state, "succeeded");
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_AUTHORIZATION_GONE" }, { now: F.at(13) }));
  assert.equal(await F.state(db.app, r.id), "cancelled");
  assert.equal(await active(r.id), 0, "verified settlement of both legs releases the dates");
  assert.deepEqual(await claimReleaseBlockers(db.app, r.id, { now: F.at(14) }), [], "nothing left unresolved");
});

test("void read shows the authorization still held -> exactly one new void with its own key", async () => {
  const r = await capFailed(L(7));
  const { op } = await F.runOp(db.app, r.id, VOID[0], 10, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok(await applyEvent(db.app, r.id, { type: "VOID_OUTCOME_UNKNOWN" }, { now: F.at(10) }));
  const held = await F.piStatus(db.app, r.id, r.piId, "requires_capture", {}, 13);
  F.ok(await settleOperationFromEvidence(db.app, op.id, held));
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_STILL_AUTHORIZED" }, { now: F.at(13) }));
  const voids = await ops(r.id, VOID[0]);
  assert.equal(voids.length, 2);
  assert.equal(voids[1].payload.providerIdempotencyKey, voidKey(r.id, r.piId, 2));
});

test("worker interruption: capture in flight when the worker dies -> unknown, reported to E3, read scheduled, never re-sent", async () => {
  const r = await F.reserved(db.app, { listingId: L(8) });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(8), intentId: r.id, opTypes: CAP, leaseMs: 60000 });
  const rec = await recoverExpiredOperations(db.app, { now: F.at(10) });
  assert.equal(rec.find((x) => x.id === op.id).state, "outcome_unknown");
  const rep = F.ok(await reportUnknownOutcome(db.app, op.id, { now: F.at(10) }));
  assert.equal(rep.intent.status, "capture_unknown");
  assert.deepEqual(rep.operations.map((o) => o.opType), ["stripe.retrieve_payment_intent"]);
  assert.equal((await reportUnknownOutcome(db.app, op.id, { now: F.at(11) })).duplicate, true, "reporting twice changes nothing");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(500), intentId: r.id, opTypes: CAP }), null);
  // the late worker's result is kept as evidence only
  const late = await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(11), outcome: { status: "succeeded" } });
  assert.deepEqual([late.error, late.lateEvidenceRecorded], ["LEASE_LOST", true]); // kept as evidence, not acted on
  assert.equal((await ops(r.id, CAP[0])).length, 1);
  // void interrupted during recovery behaves the same way
  const f = await capFailed(L(9));
  const vop = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: f.id, opTypes: VOID, leaseMs: 60000 });
  await recoverExpiredOperations(db.app, { now: F.at(11) });
  const vrep = F.ok(await reportUnknownOutcome(db.app, vop.id, { now: F.at(11) }));
  assert.equal(vrep.intent.status, "capture_failed");
  assert.deepEqual(vrep.operations.map((o) => o.opType), ["stripe.retrieve_payment_intent"]);
});

test("money captured during cancellation (read after a void failure) -> owner review; no automatic refund or cancel", async () => {
  const r = await capFailed(L(10));
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", amountMinor: 576000, currency: "MXN" }, { now: F.at(12) }));
  const i = await loadIntent(db.app, r.id);
  assert.deepEqual([i.status, i.reasonCode], ["reconciliation_required", "CAPTURED_DURING_CANCELLATION"]);
  assert.equal(await active(r.id), 1);
});

test("paid booking + failed/ambiguous Hostaway accounting update stays a valid paid booking (no cancel, no void)", async () => {
  const c = await F.captured(db.app, { listingId: L(11) });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: ["hostaway.record_offline_charge"] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  assert.equal(await F.state(db.app, c.id), "payment_captured");
  assert.equal((await ops(c.id, CANCEL[0])).length + (await ops(c.id, VOID[0])).length, 0);
  assert.equal(await active(c.id), 1, "the guest's nights stay booked");
});
