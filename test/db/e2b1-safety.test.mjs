// Stage E2B.1 — regression tests for the acceptance-review findings (claude/review-e2b-acceptance-2026-10-21.md).
// Each probe that previously SUCCEEDED (P1a–c, P3a–d, P4, P5) must now be REJECTED. Throwaway local PostgreSQL;
// provider results are mocked; the runtime code runs as mv_booking_app, owner reconciliation as mv_booking_admin.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import {
  applyEvent, beginPayStep, loadIntentRow, applyResolution, applyCheckoutSessionEvidence, tryReleaseClaim, claimReleaseBlockers
} from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, recordProviderEvidence, requestRead } from "../../db/lib/operations.js";
import { adminResolveOperation, adminResolveIntent, adminAcquireClaim, adminRecordEvidence } from "../../db/lib/admin.js";

let db, report;
before(async () => { db = await startMigratedDatabase(); report = new pg.Pool({ connectionString: db.reportUrl(), max: 2 }); });
after(async () => { await report.end(); await db.close(); });
const L = (n) => 790000 + n;
const OCH = ["hostaway.record_offline_charge"];
const active = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id]);
const charges = (ids) => ({ matchingChargeCount: ids.length, matchingChargeIds: ids.map(String) });
const ambiguousRecording = async (listingId) => {
  const c = await F.captured(db.app, { listingId });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  return { ...c, op };
};

// ---------------------------------------------------------------- C1 (was P1a, P1b, P1c)
test("C1 / P1a: a resolver name or a bare flag cannot authorize another Hostaway payment recording", async () => {
  const c = await ambiguousRecording(L(1));
  // the runtime role cannot even call the owner function
  await assert.rejects(db.app.query("SELECT booking.admin_resolve_operation($1, 'failed_definite', '{}'::uuid[], NULL, 'x', 'X', now())", [c.op.id]), /permission denied/);
  // the owner function refuses no evidence, a name alone, and absence observed by a single source
  const r0 = await adminResolveOperation(db.reconciler, { operationId: c.op.id, decision: "failed_definite", evidenceIds: [], resolver: "x", justification: "FLAG", at: F.at(60) });
  assert.equal(r0.error, "EVIDENCE_REQUIRED");
  const api = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", String(c.reservationId), "listed", charges([]), 40);
  const r1 = await adminResolveOperation(db.reconciler, { operationId: c.op.id, decision: "failed_definite", evidenceIds: [api], resolver: "x", justification: "FLAG", at: F.at(60) });
  assert.equal(r1.error, "INSUFFICIENT_EVIDENCE", "Hostaway lookup absence alone is not proof the earlier call failed");
  // evidence belonging to another booking is refused
  const other = await ambiguousRecording(L(2));
  const foreign = await F.readEvidence(db.app, other.id, "hostaway_offline_charges", String(other.reservationId), "listed", charges([]), 40);
  assert.equal((await adminResolveOperation(db.reconciler, { operationId: c.op.id, decision: "failed_definite", evidenceIds: [api, foreign],
    resolver: "x", justification: "FLAG", at: F.at(60) })).error, "EVIDENCE_NOT_FOR_THIS_INTENT");
  // nothing changed: still ambiguous, retry refused, no second operation
  assert.equal((await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) })).error, "OFFLINE_CHARGE_OUTCOME_UNRESOLVED");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'", [c.id]), 1);
});

test("C1 / P1b: the runtime role cannot settle an uncertain operation or plant a second recording with raw SQL", async () => {
  const c = await ambiguousRecording(L(3));
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'failed_definite' WHERE id = $1", [c.op.id]), /OWNER_RESOLUTION_REQUIRED/);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'succeeded', result_ref = '1' WHERE id = $1", [c.op.id]), /OWNER_RESOLUTION_REQUIRED/);
  await assert.rejects(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, source_version,
      max_attempts, next_attempt_at, created_at, updated_at) VALUES ($1, $2, 'hostaway.record_offline_charge', $3, 'non_idempotent', 'pending', 99, 1, now(), now(), now())`,
    [randomUUID(), c.id, `och:${c.id}:raw`]), /PRIOR_RECORDING_NOT_VERIFIED_FAILED/);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET resolution_id = gen_random_uuid() WHERE id = $1", [c.op.id]), /owner functions|foreign key/);
  // the admin login cannot write tables directly either — only through the evidence-checking functions
  await assert.rejects(db.reconciler.query("UPDATE booking.external_operations SET state = 'failed_definite' WHERE id = $1", [c.op.id]), /permission denied/);
  await assert.rejects(db.reconciler.query("INSERT INTO booking.reconciliation_resolutions (id, intent_id, decision, operation_id, evidence_ids, resolver, justification_code, resolver_session_user, decided_at) VALUES (gen_random_uuid(), $1, 'operation_failed', $2, ARRAY[gen_random_uuid()], 'x', 'X', 'x', now())", [c.id, c.op.id]), /permission denied/);
});

test("C1 / P1c: a worker cannot report a timeout as a definite failure (no catalogued refusal yet)", async () => {
  const c = await F.captured(db.app, { listingId: L(4) });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(9), intentId: c.id, opTypes: OCH });
  const r = await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "failed_definite", errorCode: "TIMEOUT" } });
  assert.equal(r.error, "NOT_A_CATALOGUED_DEFINITE_REFUSAL");
  assert.equal((await db.app.query("SELECT state FROM booking.external_operations WHERE id = $1", [op.id])).rows[0].state, "in_flight");
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(9.3), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  assert.equal((await applyEvent(db.app, c.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(10) })).error, "OFFLINE_CHARGE_OUTCOME_UNRESOLVED");
});

test("C1/C4: evidence is persisted only from a succeeded read of the matching type (runtime), or attested by the owner", async () => {
  const c = await ambiguousRecording(L(5));
  await assert.rejects(db.app.query(`INSERT INTO booking.provider_evidence (id, intent_id, kind, source, external_ref, status, observed, observed_at, attested_by, reference, recorded_by_role, recorded_session_user)
      VALUES (gen_random_uuid(), $1, 'hostaway_offline_charges', 'hostaway_dashboard', 'x', 'listed', '{}', now(), 'a', 'b', 'x', 'x')`, [c.id]), /permission denied/);
  await assert.rejects(db.app.query("SELECT booking.admin_record_evidence($1, 'hostaway_offline_charges', 'x', 'listed', '{}', now(), 'a', 'b')", [c.id]), /permission denied/);
  const readId = await requestRead(db.app, c.id, "hostaway.list_offline_charges", String(c.reservationId), { now: F.at(30) });
  assert.equal((await recordProviderEvidence(db.app, { readOpId: readId, kind: "hostaway_offline_charges", externalRef: String(c.reservationId),
    status: "listed", observed: charges([]) })).error, "EVIDENCE_NEEDS_SUCCEEDED_READ", "a read that never ran proves nothing");
  const op = await claimNextOperation(db.app, { workerId: "w-r", now: F.at(30), intentId: c.id, opTypes: ["hostaway.list_offline_charges"] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-r", now: F.at(30), outcome: { status: "succeeded" } }));
  assert.equal((await recordProviderEvidence(db.app, { readOpId: readId, kind: "hostaway_offline_charges", externalRef: "999",
    status: "listed", observed: charges([]) })).error, "EVIDENCE_REF_MISMATCH");
  assert.equal((await recordProviderEvidence(db.app, { readOpId: readId, kind: "payment_intent", externalRef: String(c.reservationId),
    status: "canceled", observed: {} })).error, "EVIDENCE_KIND_DOES_NOT_MATCH_READ");
  const ok1 = F.ok(await recordProviderEvidence(db.app, { readOpId: readId, kind: "hostaway_offline_charges", externalRef: String(c.reservationId),
    status: "listed", observed: charges([]), providerRequestId: "req_123" }));
  const ev = (await db.app.query("SELECT * FROM booking.provider_evidence WHERE id = $1", [ok1.id])).rows[0];
  assert.deepEqual([ev.source, ev.read_operation_id, ev.recorded_session_user, ev.provider_request_id], ["hostaway_api", readId, "test_app", "req_123"]);
  assert.equal((await recordProviderEvidence(db.app, { readOpId: readId, kind: "hostaway_offline_charges", externalRef: String(c.reservationId),
    status: "listed", observed: charges([]) })).error, "EVIDENCE_ALREADY_RECORDED", "one evidence row per read");
  await assert.rejects(db.app.query("UPDATE booking.provider_evidence SET status = 'x' WHERE id = $1", [ok1.id]), /permission denied/);
  await assert.rejects(db.owner.query("UPDATE booking.provider_evidence SET status = 'x' WHERE id = $1", [ok1.id]), /not allowed/);
  // dashboard evidence: admin only, with attestation and reference
  const dash = F.ok(await adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "hostaway_offline_charges", externalRef: String(c.reservationId),
    status: "listed", observed: charges([]), observedAt: F.at(45), attestedBy: "joel", reference: "hostaway-payments-report-2026-10-21" }));
  const d = (await db.app.query("SELECT source, attested_by, reference, recorded_session_user FROM booking.provider_evidence WHERE id = $1", [dash.id])).rows[0];
  assert.deepEqual(d, { source: "hostaway_dashboard", attested_by: "joel", reference: "hostaway-payments-report-2026-10-21", recorded_session_user: "test_admin" });
  assert.equal((await adminRecordEvidence(db.reconciler, { intentId: c.id, kind: "hostaway_offline_charges", externalRef: "1", status: "listed",
    observed: charges([]), observedAt: F.at(45), attestedBy: null, reference: null })).ok, false, "attestation required");
});

// ---------------------------------------------------------------- C3 (was P3a)
test("C3 / P3a: a single declined card ends nothing — dates kept, the guest can still pay in the same checkout", async () => {
  const p = await F.pending(db.app, { listingId: L(10) });
  assert.equal((await applyEvent(db.app, p.id, { type: "PAYMENT_FAILED", code: "CARD_DECLINED" }, { now: F.at(10) })).error, "CHECKOUT_EXPIRY_NOT_VERIFIED");
  assert.equal(await F.state(db.app, p.id), "payment_pending");
  assert.equal(await active(p.id), 1);
  await assert.rejects(db.app.query("UPDATE booking.payment_attempts SET status = 'failed' WHERE id = $1", [p.attemptId]), /CHECKOUT_EXPIRY_NOT_VERIFIED/);
  await assert.rejects(db.app.query("UPDATE booking.payment_attempts SET status = 'expired' WHERE id = $1", [p.attemptId]), /CHECKOUT_EXPIRY_NOT_VERIFIED/);
  // an "open" session read does not end it either
  const open = await F.readEvidence(db.app, p.id, "checkout_session", p.sessionId, "open", {}, 12);
  F.ok(await applyCheckoutSessionEvidence(db.app, p.id, p.attemptId, open, { now: F.at(12) }));
  assert.equal(await active(p.id), 1);
  // the guest retries with another card and succeeds: the booking continues normally
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, "pi_retry_ok", 14), { now: F.at(14) }));
  assert.equal(await F.state(db.app, p.id), "payment_authorized");
});

// ---------------------------------------------------------------- C4 (was P3b)
test("C4 / P3b: manual 'released' needs persisted evidence — booleans are refused; unproven Hostaway absence is refused", async () => {
  // (i) authorization held, escalated
  const a = await F.authorized(db.app, { listingId: L(20) });
  F.ok(await applyEvent(db.app, a.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(6) }));
  assert.equal((await applyEvent(db.app, a.id, { type: "RESOLVE", outcome: "released", evidence: { authorizationVoided: true, noReservation: true }, resolvedBy: "o" },
    { now: F.at(7) })).error, "RESOLUTION_REQUIRED");
  await assert.rejects(db.app.query("UPDATE booking.intents SET state = 'authorization_released', version = version + 1 WHERE id = $1", [a.id]), /RESOLUTION_REQUIRED/);
  const sessionEv = await F.readEvidence(db.app, a.id, "checkout_session", a.sessionId, "complete", {}, 8);
  const noPi = await adminResolveIntent(db.reconciler, { intentId: a.id, decision: "released", evidenceIds: [sessionEv], resolver: "owner", justification: "X", at: F.at(9) });
  assert.equal(noPi.error, "INSUFFICIENT_EVIDENCE");
  assert.match(noPi.detail, /AUTHORIZATION_UNSETTLED/);
  assert.equal(await active(a.id), 1);
  const piHeld = await F.piStatus(db.app, a.id, a.piId, "requires_capture", {}, 10);
  assert.equal((await adminResolveIntent(db.reconciler, { intentId: a.id, decision: "released", evidenceIds: [piHeld], resolver: "owner", justification: "X", at: F.at(10) })).error,
    "INSUFFICIENT_EVIDENCE", "an authorization still held is not released");
  const piCanceled = await F.piStatus(db.app, a.id, a.piId, "canceled", {}, 11);
  const res = F.ok(await adminResolveIntent(db.reconciler, { intentId: a.id, decision: "released", evidenceIds: [piCanceled], resolver: "owner", justification: "VOIDED_IN_STRIPE", at: F.at(11) }));
  F.ok(await applyResolution(db.app, a.id, res.id, { now: F.at(12) }));
  assert.equal(await F.state(db.app, a.id), "authorization_released");
  assert.equal(await active(a.id), 0);
  const row = (await db.app.query("SELECT * FROM booking.reconciliation_resolutions WHERE id = $1", [res.id])).rows[0];
  assert.deepEqual([row.decision, row.resolver, row.justification_code, row.evidence_ids, row.resolver_session_user, row.consumed_version !== null],
    ["intent_released", "owner", "VOIDED_IN_STRIPE", [piCanceled], "test_admin", true]);
  assert.equal((await applyResolution(db.app, a.id, res.id, { now: F.at(13) })).error, "RESOLUTION_ALREADY_USED");

  // (ii) Hostaway create dispatched, outcome unknown, lookup says "not found": cannot be released before E4
  const d = await F.dispatched(db.app, { listingId: L(21) });
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(7) }));
  F.ok(await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_ABSENT" }, { now: F.at(8) }));
  // the reconciler's lookup (queued by E3) runs and finds nothing
  const lk = await claimNextOperation(db.app, { workerId: "w-l", now: F.at(9), intentId: d.id, opTypes: ["hostaway.lookup_reservation"] });
  F.ok(await completeOperation(db.app, lk.id, { workerId: "w-l", now: F.at(9), outcome: { status: "succeeded" } }));
  const notFound = F.ok(await recordProviderEvidence(db.app, { readOpId: lk.id, kind: "hostaway_reservation", externalRef: "NONE", status: "not_found",
    observed: { bookingRef: (await loadIntentRow(db.app, d.id)).ref } })).id;
  const piC = await F.piStatus(db.app, d.id, d.piId, "canceled", {}, 10);
  const r2 = await adminResolveIntent(db.reconciler, { intentId: d.id, decision: "released", evidenceIds: [piC, notFound], resolver: "owner", justification: "X", at: F.at(11) });
  assert.equal(r2.error, "INSUFFICIENT_EVIDENCE");
  assert.match(r2.detail, /RESERVATION_OUTCOME_UNRESOLVED/);
  const createOp = (await db.app.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [d.id])).rows[0];
  assert.ok(createOp);
  assert.equal(await active(d.id), 1, "dates stay claimed while a reservation may exist");
});

// ---------------------------------------------------------------- C5 (was P3c)
test("C5 / P3c: failed capture — E3 schedules cancel + void; each leg needs verification; dates kept until both settle", async () => {
  const r = await F.reserved(db.app, { listingId: L(30) });
  await F.runOp(db.app, r.id, "stripe.capture_payment_intent", 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  const cf = F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  assert.deepEqual(cf.operations.map((o) => o.opType).sort(), ["alert.owner", "hostaway.cancel_reservation", "stripe.void_payment_intent"]);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [r.id]), 1,
    "exactly one void (no database-side duplicate)");
  assert.equal((await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(9) })).error, "CANCELLATION_NOT_VERIFIED");
  await F.runOp(db.app, r.id, "hostaway.cancel_reservation", 9);
  assert.equal((await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(9) })).error, "CANCELLATION_NOT_VERIFIED",
    "the cancel call returning is not enough; a read must show the reservation cancelled");
  await F.reservationStatus(db.app, r.id, String(r.reservationId), "cancelled", {}, 10);
  F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCELLED" }, { now: F.at(10) }));
  assert.equal(await F.state(db.app, r.id), "capture_failed", "E3.2: cancellation is one of two legs");
  assert.equal(await active(r.id), 1, "authorization not yet settled");
  const b = await claimReleaseBlockers(db.app, r.id);
  assert.ok(b.some((x) => x.startsWith("STATE_NOT_RELEASABLE")), b.join());
  assert.equal((await applyEvent(db.app, r.id, { type: "VOID_SUCCEEDED" }, { now: F.at(11) })).error, "AUTHORIZATION_NOT_VERIFIED_SETTLED");
  await F.runOp(db.app, r.id, "stripe.void_payment_intent", 11);
  F.ok(await applyEvent(db.app, r.id, { type: "VOID_SUCCEEDED" }, { now: F.at(11) }));
  assert.equal(await F.state(db.app, r.id), "cancelled");
  assert.equal(await active(r.id), 0, "released in the same transaction once both legs are verified");
});

test("C5: an ambiguous cancellation keeps the dates and is reconciled by a read, never re-sent blindly", async () => {
  const r = await F.reserved(db.app, { listingId: L(31) });
  await F.runOp(db.app, r.id, "stripe.capture_payment_intent", 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  const { op: cancelOp } = await F.runOp(db.app, r.id, "hostaway.cancel_reservation", 9, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  assert.equal((await db.app.query("SELECT state FROM booking.external_operations WHERE id = $1", [cancelOp.id])).rows[0].state, "outcome_unknown");
  F.ok(await applyEvent(db.app, r.id, { type: "RESERVATION_CANCEL_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(9) }));
  assert.equal(await F.state(db.app, r.id), "capture_failed");
  assert.equal(await active(r.id), 1);
  assert.equal(await claimNextOperation(db.app, { workerId: "w9", now: F.at(500), intentId: r.id, opTypes: ["hostaway.cancel_reservation"] }), null, "no blind re-send");
  // definite cancel failure instead -> owner reconciliation, dates kept
  const r2 = await F.reserved(db.app, { listingId: L(32) });
  await F.runOp(db.app, r2.id, "stripe.capture_payment_intent", 8, { status: "failed_definite", errorCode: "CARD_DECLINED" });
  F.ok(await applyEvent(db.app, r2.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  F.ok(await applyEvent(db.app, r2.id, { type: "RESERVATION_CANCEL_FAILED" }, { now: F.at(9) }));
  assert.equal(await F.state(db.app, r2.id), "reconciliation_required");
  assert.equal(await active(r2.id), 1);
});

test("C2 / P3d: the runtime role cannot release claims; even the owner cannot release while anything is unresolved", async () => {
  const a = await F.authorized(db.app, { listingId: L(40) });
  await assert.rejects(db.app.query("UPDATE booking.inventory_claims SET released_at = now(), release_reason = 'X' WHERE intent_id = $1", [a.id]), /permission denied/);
  assert.equal(await tryReleaseClaim(db.app, a.id), false);
  await assert.rejects(db.owner.query("UPDATE booking.inventory_claims SET released_at = now(), release_reason = 'X' WHERE intent_id = $1", [a.id]), /CLAIM_RELEASE_BLOCKED/);
  // corrupting the intent state with raw SQL does not unlock the dates either
  await db.app.query("UPDATE booking.intents SET state = 'cancelled', version = version + 1 WHERE id = $1", [a.id]);
  const b = await claimReleaseBlockers(db.app, a.id);
  assert.ok(b.some((x) => x.startsWith("AUTHORIZATION_UNSETTLED")), b.join());
  assert.equal(await tryReleaseClaim(db.app, a.id), false);
  assert.equal(await active(a.id), 1);
});

// ---------------------------------------------------------------- C6 (was P4)
test("C6 / P4: no payment step without this intent's active claim; owner confirmation must re-acquire the nights", async () => {
  const id = await F.withDetails(db.app, { listingId: L(50) });
  assert.equal((await applyEvent(db.app, id, { type: "CHECKOUT_PREPARED", sessionId: "cs_bypass" }, { now: F.at(2) })).error, "CLAIM_REQUIRED");
  await assert.rejects(db.app.query("UPDATE booking.intents SET state = 'payment_pending', version = version + 1 WHERE id = $1", [id]), /CLAIM_REQUIRED/);
  await assert.rejects(db.app.query(`INSERT INTO booking.payment_attempts (id, intent_id, attempt, idempotency_key, status, amount_minor, currency, planned_session_expires_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 1, $2, 'creating', 576000, 'MXN', now(), now(), now())`, [id, `cs:${id}:1`]), /CLAIM_REQUIRED/);
  // a claim cannot be planted for an intent that is not at the Pay step
  const priced = await F.priced(db.app, { listingId: L(51) });
  await assert.rejects(db.app.query(`INSERT INTO booking.inventory_claims (intent_id, listing_id, stay, kind, claimed_at, review_after)
     SELECT id, listing_id, stay, 'checkout', now(), now() FROM booking.intents WHERE id = $1`, [priced]), /only at the Pay step/);
  // rival can still claim the nights the bypass never held
  const rival = await F.withDetails(db.app, { listingId: L(50) });
  F.ok(await beginPayStep(db.app, rival, { now: F.at(2) }));

  // late authorization on an expired intent, then owner confirmation: must re-acquire the claim
  const p = await F.pending(db.app, { listingId: L(52) });
  await F.sessionExpired(db.app, p, 33);
  F.ok(await applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_c6" }, { now: F.at(33) }));
  assert.equal(await active(p.id), 0);
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, "pi_late_c6", 34), { now: F.at(34) }));
  assert.equal(await F.state(db.app, p.id), "reconciliation_required");
  const found = await F.reservationStatus(db.app, p.id, "88001", "found_active", { listingId: L(52), from: "2026-12-20", to: "2026-12-24", totalMinor: 576000 }, 40);
  const paid = await F.piStatus(db.app, p.id, "pi_late_c6", "succeeded", { amountReceivedMinor: 576000 }, 41);
  const res = F.ok(await adminResolveIntent(db.reconciler, { intentId: p.id, decision: "confirmed", evidenceIds: [found, paid], resultRef: "88001", resolver: "owner", justification: "BOOKED_MANUALLY", at: F.at(42) }));
  assert.equal((await applyResolution(db.app, p.id, res.id, { now: F.at(43) })).error, "CLAIM_REQUIRED");
  // another guest holds those nights now -> re-acquire refused by the exclusion constraint
  const holder = await F.withDetails(db.app, { listingId: L(52) }, 35);
  F.ok(await beginPayStep(db.app, holder, { now: F.at(36) }));
  assert.equal((await adminAcquireClaim(db.reconciler, { intentId: p.id, at: F.at(44) })).error, "DATES_CLAIMED");
});

// ---------------------------------------------------------------- C7 (was P5)
test("C7 / P5: privileges — runtime cannot resolve cases; PUBLIC executes nothing; roles see only what they need", async () => {
  const a = await F.authorized(db.app, { listingId: L(60) });
  F.ok(await applyEvent(db.app, a.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(6) }));
  await assert.rejects(db.app.query("UPDATE booking.reconciliation_cases SET status = 'resolved', resolution = 'no_action', resolved_by = 'app', resolved_at = now() WHERE intent_id = $1", [a.id]), /permission denied/);
  const q = (sql) => db.owner.query(sql).then((r) => r.rows);
  const publicExec = await q("SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND has_function_privilege('public', p.oid, 'EXECUTE')");
  assert.deepEqual(publicExec, [], "no booking function is executable by PUBLIC");
  const appAdmin = await q("SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname LIKE 'admin_%' AND has_function_privilege('mv_booking_app', p.oid, 'EXECUTE')");
  assert.deepEqual(appAdmin, [], "runtime role cannot call owner functions");
  const appWrites = await q(`SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = 'mv_booking_app'
                             AND table_name IN ('inventory_claims', 'reconciliation_cases', 'provider_evidence', 'reconciliation_resolutions', 'definite_refusal_codes')
                             AND privilege_type IN ('UPDATE', 'DELETE') ORDER BY 1, 2`);
  assert.deepEqual(appWrites, []);
  await assert.rejects(db.reconciler.query("SELECT * FROM booking.intent_guests"), /permission denied/);
  await assert.rejects(report.query("SELECT * FROM booking.intent_guests"), /permission denied/);
  await assert.rejects(db.app.query("INSERT INTO booking.definite_refusal_codes (op_type, code, note) VALUES ('hostaway.create_reservation', 'X', 'x')"), /permission denied/);
  assert.equal((await q("SELECT relrowsecurity FROM pg_class WHERE oid = 'booking_migrations.applied'::regclass"))[0].relrowsecurity, true);
  const rls = await q("SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'booking'::regnamespace AND relkind = 'r' AND NOT relrowsecurity");
  assert.equal(rls[0].n, 0);
});

test("C1: no reservation-create re-dispatch is reachable — owner 'failed' on a create is refused until E4", async () => {
  const d = await F.dispatched(db.app, { listingId: L(70) });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "outcome_unknown" } }));
  const piC = await F.piStatus(db.app, d.id, d.piId, "requires_capture", {}, 30);
  const r = await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "failed_definite", evidenceIds: [piC], resolver: "owner", justification: "X", at: F.at(31) });
  assert.equal(r.error, "NOT_PERMITTED_UNTIL_E4");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [d.id]), 1);
});

// ---------------------------------------------------------------- concurrency
test("concurrency: release racing new guests never yields overlapping active claims (10 rounds)", async () => {
  let grantedAfterRelease = 0;
  for (let i = 0; i < 10; i++) {
    const stay = { listingId: L(100 + i), from: "2027-10-01", to: "2027-10-04" };
    const p = await F.pending(db.app, stay);
    const ev = await F.sessionExpired(db.app, p, 33);
    const rivals = [];
    for (let k = 0; k < 3; k++) rivals.push(await F.withDetails(db.app, { ...stay, from: "2027-10-02", to: "2027-10-05" }, 33));
    const results = await Promise.all([
      applyCheckoutSessionEvidence(db.app, p.id, p.attemptId, ev, { now: F.at(34) }),
      ...rivals.map((r) => beginPayStep(db.app, r, { now: F.at(34) }))
    ]);
    const granted = results.slice(1).filter((r) => r.ok).length;
    assert.ok(granted <= 1);
    grantedAfterRelease += granted;
    const overlaps = await F.count(db.app, `SELECT count(*) AS n FROM booking.inventory_claims x JOIN booking.inventory_claims y
        ON x.id < y.id AND x.listing_id = y.listing_id AND x.stay && y.stay WHERE x.released_at IS NULL AND y.released_at IS NULL AND x.listing_id = $1`, [stay.listingId]);
    assert.equal(overlaps, 0);
  }
  assert.ok(grantedAfterRelease <= 10);
});

test("concurrency: two owners apply the same resolution / settle the same operation at once -> exactly one succeeds", async () => {
  const a = await F.authorized(db.app, { listingId: L(120) });
  F.ok(await applyEvent(db.app, a.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(6) }));
  const piC = await F.piStatus(db.app, a.id, a.piId, "canceled", {}, 8);
  const res = F.ok(await adminResolveIntent(db.reconciler, { intentId: a.id, decision: "released", evidenceIds: [piC], resolver: "owner", justification: "X", at: F.at(9) }));
  const both = await Promise.all([applyResolution(db.app, a.id, res.id, { now: F.at(10) }), applyResolution(db.app, a.id, res.id, { now: F.at(10) })]);
  assert.equal(both.filter((r) => r.ok && !r.duplicate).length, 1);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = 'RESOLVE'", [a.id]), 1);

  const c = await ambiguousRecording(L(121));
  const rid = String(c.reservationId);
  const api = await F.readEvidence(db.app, c.id, "hostaway_offline_charges", rid, "listed", charges([]), 40);
  const dash = await F.dashboardEvidence(db.reconciler, c.id, "hostaway_offline_charges", rid, "listed", charges([]), 45);
  const two = await Promise.all([1, 2].map(() => adminResolveOperation(db.reconciler, { operationId: c.op.id, decision: "failed_definite",
    evidenceIds: [api, dash], resolver: "owner", justification: "NO_CHARGE", at: F.at(60) })));
  assert.equal(two.filter((r) => r.ok).length, 1);
  assert.equal(two.filter((r) => r.error === "NOT_RESOLVABLE").length, 1);
});
