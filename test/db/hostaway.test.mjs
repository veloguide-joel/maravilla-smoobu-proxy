// Stage E2B — Hostaway reservation attempts: write-before-send, one create per intent, crash recovery at the
// write-before-send and provider-result boundaries, ambiguous outcomes, "not found" is not proof (R1).
// Provider results are mocked constants; nothing is sent anywhere.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import {
  applyEvent, recoverInterruptedReservations, recordHostawayCreateResult, recordHostawayLookup, loadIntentRow
} from "../../db/lib/repo.js";
import { claimNextOperation, completeOperation, recoverExpiredOperations } from "../../db/lib/operations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const attemptOf = async (id) => (await db.app.query("SELECT * FROM booking.hostaway_reservation_attempts WHERE intent_id = $1", [id])).rows[0];
const createOps = async (id) => (await db.app.query("SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.create_reservation'", [id])).rows;

test("write-before-send: the dispatch record commits with the transition, before any create can be claimed", async () => {
  const a = await F.authorized(db.app, { listingId: 740001 });
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), workerId: "w1" }));
  assert.equal(await claimNextOperation(db.app, { workerId: "w1", now: F.at(6), intentId: a.id, opTypes: ["hostaway.create_reservation"] }), null, "nothing to send before dispatch");
  // a failure inside the dispatch transaction leaves NO attempt row and NO create operation
  await assert.rejects(applyEvent(db.app, a.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), inTx: () => { throw new Error("crash"); } }));
  assert.equal(await attemptOf(a.id), undefined);
  assert.equal((await createOps(a.id)).length, 0);
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), workerId: "w1" }));
  const att = await attemptOf(a.id);
  assert.equal(att.state, "dispatched");
  assert.equal(att.send_started_at, null, "recorded before sending");
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: a.id, opTypes: ["hostaway.create_reservation"] });
  assert.ok(op);
  assert.ok((await attemptOf(a.id)).send_started_at, "send start recorded when the worker claims it");
});

test("one Hostaway create per intent, ever — enforced by the database, not just the code", async () => {
  const d = await F.dispatched(db.app, { listingId: 740002 });
  const r = await applyEvent(db.app, d.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6) });
  assert.equal(r.error, "ALREADY_DISPATCHED"); // E3 refuses
  await assert.rejects(db.app.query(`INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, source_version, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES ($1, $2, 'hostaway.create_reservation', $3, 'non_idempotent', 'pending', 99, 1, now(), now(), now())`, [randomUUID(), d.id, `hcreate-bypass:${d.id}`]), /one_hostaway_create/);
  await assert.rejects(db.app.query(`INSERT INTO booking.hostaway_reservation_attempts (id, intent_id, operation_id, booking_ref, state, dispatched_at, updated_at)
    VALUES ($1, $2, $3, 'MV-XXXXXX', 'dispatched', now(), now())`, [randomUUID(), d.id, d.createOpId]), /duplicate key/);
  // the single create op can be attempted only once, and never put back to pending
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'pending', lease_worker_id = NULL, lease_until = NULL WHERE id = $1", [op.id]), /not allowed/);
});

test("crash at the write-before-send boundary (dispatched, never claimed): recovery -> reservation_unknown, create superseded forever", async () => {
  const d = await F.dispatched(db.app, { listingId: 740003 });
  const rec = await recoverInterruptedReservations(db.app, { now: F.at(30) }); // lease (2 min) long expired
  assert.equal(rec.find((x) => x.intentId === d.id).status, "reservation_unknown");
  assert.equal((await createOps(d.id))[0].state, "superseded");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(31), intentId: d.id, opTypes: ["hostaway.create_reservation"] }), null);
  assert.equal((await attemptOf(d.id)).state, "outcome_unknown");
  assert.equal((await attemptOf(d.id)).send_started_at, null, "evidence: the request was never handed to a sender");
  // still no automatic second create: E3 has no route from reservation_unknown to a new dispatch
  assert.equal((await applyEvent(db.app, d.id, { type: "RESERVATION_STARTED", workerId: "w2", recheck: { bookable: true, priceSame: true } }, { now: F.at(31) })).error, "ILLEGAL_TRANSITION");
});

test("crash while sending (in flight): op -> outcome_unknown + case; intent -> reservation_unknown; never retried", async () => {
  const d = await F.dispatched(db.app, { listingId: 740004 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  const ops = await recoverExpiredOperations(db.app, { now: F.at(9) });
  assert.equal(ops.find((x) => x.id === op.id).state, "outcome_unknown");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'HOSTAWAY_CREATE_OUTCOME_UNKNOWN'", [d.id]), 1);
  await recoverInterruptedReservations(db.app, { now: F.at(9) });
  assert.equal(await F.state(db.app, d.id), "reservation_unknown");
  assert.equal(await claimNextOperation(db.app, { workerId: "w2", now: F.at(100), intentId: d.id, opTypes: ["hostaway.create_reservation"] }), null);
  // the worker reappears with a late 201: kept as evidence; E3 refuses the late success (intent moved on)
  const late = await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(10), outcome: { status: "succeeded", resultRef: 77001 } });
  assert.equal(late.error, "LEASE_LOST");
  assert.equal(late.lateEvidenceRecorded, true);
  assert.equal((await applyEvent(db.app, d.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor({ listingId: 740004 }, 77001) }, { now: F.at(10) })).error, "ILLEGAL_TRANSITION");
  // reconciliation with a FRESH lookup (mocked: found, matching) moves it on and schedules capture
  await recordHostawayLookup(db.app, d.id, { result: "found" }, { now: F.at(11) });
  F.ok(await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_FOUND", reservation: F.reservationFor({ listingId: 740004 }, 77001) }, { now: F.at(11), actor: "reconciler" }));
  assert.equal(await F.state(db.app, d.id), "reservation_confirmed");
  assert.equal((await attemptOf(d.id)).state, "reconciled_found");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [d.id]), 1);
});

test("crash at the provider-result boundary (result recorded, transition not applied): recovery uses the evidence path", async () => {
  const d = await F.dispatched(db.app, { listingId: 740005 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: F.reservationFor({ listingId: 740005 }, 77002) }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: 77002 } }));
  // ...worker dies here, before RESERVATION_SUCCEEDED
  const att = await attemptOf(d.id);
  assert.equal(att.hostaway_reservation_id, "77002");
  assert.equal(att.state, "dispatched");
  await recoverInterruptedReservations(db.app, { now: F.at(30) });
  assert.equal(await F.state(db.app, d.id), "reservation_unknown", "never back to payment_authorized once dispatched");
  F.ok(await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_FOUND", reservation: F.reservationFor({ listingId: 740005 }, 77002) }, { now: F.at(31), actor: "reconciler" }));
  assert.equal(await F.state(db.app, d.id), "reservation_confirmed");
  // first recorded result wins: a second, different result cannot overwrite the evidence
  assert.equal((await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: F.reservationFor({ listingId: 740005 }, 99999) }, { now: F.at(32) })).recorded, false);
  assert.equal((await attemptOf(d.id)).hostaway_reservation_id, "77002");
});

test("crash before dispatch (lease only): safe to retry — nothing could have been sent", async () => {
  const a = await F.authorized(db.app, { listingId: 740006 });
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6) }));
  assert.equal((await recoverInterruptedReservations(db.app, { now: F.at(9) })).find((x) => x.intentId === a.id).status, "payment_authorized");
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w2", recheck: { bookable: true, priceSame: true } }, { now: F.at(10) }));
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_DISPATCHED", workerId: "w2" }, { now: F.at(10) }));
  assert.equal((await createOps(a.id)).length, 1);
  // a stale worker cannot dispatch under someone else's (or an expired) lease
  const b = await F.authorized(db.app, { listingId: 740007 });
  F.ok(await applyEvent(db.app, b.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6) }));
  assert.equal((await applyEvent(db.app, b.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(9) })).error, "LEASE_NOT_HELD");
  assert.equal((await createOps(b.id)).length, 0);
});

test("ambiguous create (timeout/5xx/429): reservation_unknown; 'not found' is never proof; no void, claim kept", async () => {
  const d = await F.dispatched(db.app, { listingId: 740008 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_OUTCOME_UNKNOWN", code: "TIMEOUT" }, { now: F.at(7) }));
  assert.equal(await F.state(db.app, d.id), "reservation_unknown");
  // lookup (mocked) says not found — even if a caller claims it is authoritative, it is refused until E4
  await recordHostawayLookup(db.app, d.id, { result: "not_found" }, { now: F.at(8) });
  assert.equal((await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_ABSENT", authoritative: true }, { now: F.at(8) })).error, "ABSENCE_NOT_AUTHORITATIVE_UNTIL_E4");
  F.ok(await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_ABSENT" }, { now: F.at(8) }));
  const row = await loadIntentRow(db.app, d.id);
  assert.equal(row.state, "reconciliation_required");
  assert.equal(row.reason_code, "RESERVATION_ABSENCE_UNPROVEN");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [d.id]), 0, "no automatic void");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [d.id]), 2); // op case + intent case
  assert.equal((await attemptOf(d.id)).state, "escalated");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [d.id]), 1);
  // E3's own guard is also active: definite failure must be explicit
  const e = await F.dispatched(db.app, { listingId: 740009 });
  assert.equal((await applyEvent(db.app, e.id, { type: "RESERVATION_FAILED" }, { now: F.at(7) })).error, "NOT_DEFINITE");
});

test("definite refusal (catalogued 4xx, mocked): reservation_failed -> one void op; the create is never re-sent", async () => {
  const d = await F.dispatched(db.app, { listingId: 740010 });
  const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(6.5), intentId: d.id, opTypes: ["hostaway.create_reservation"] });
  await recordHostawayCreateResult(db.app, d.id, { httpStatus: 409, refusalCode: "OVERBOOKING_REFUSED" }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "failed_definite", errorCode: "OVERBOOKING_REFUSED" } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_FAILED", definite: true, code: "OVERBOOKING_REFUSED" }, { now: F.at(7) }));
  assert.equal((await attemptOf(d.id)).state, "refused");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.void_payment_intent'", [d.id]), 1);
  assert.equal((await createOps(d.id)).length, 1);
});
