// Stage E2B.2 — final database corrections. Throwaway local PostgreSQL only; provider results are mocked constants.
//   A: release and purge decisions use PostgreSQL's clock; a caller cannot advance them with a future timestamp.
//   B: an interrupted or uncertain Stripe Checkout Session create is reconciled before any further create.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import {
  applyEvent, beginPayStep, recordCheckoutSession, releaseCompletedStayClaims, tryReleaseClaim, claimReleaseBlockers, purgeGuestData, loadIntent
} from "../../db/lib/repo.js";
import {
  claimNextOperation, completeOperation, recoverExpiredOperations, requestRead, recordProviderEvidence, settleOperationFromEvidence
} from "../../db/lib/operations.js";
import { adminResolveOperation } from "../../db/lib/admin.js";

let db, adminLogin;
before(async () => {
  db = await startMigratedDatabase();
  adminLogin = new pg.Pool({ connectionString: db.adminUrl2(), max: 2 });
});
after(async () => { await adminLogin.end(); await db.close(); });

const FUTURE = "2099-01-01T00:00:00Z";
const L = (n) => 790000 + n;
const active = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id]);
const guests = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_guests WHERE intent_id = $1", [id]);
const dbNow = async () => new Date((await db.app.query("SELECT statement_timestamp() AS t")).rows[0].t).getTime();
const csOps = async (id) => (await db.app.query(
  "SELECT id, state, retry_class, attempts, max_attempts, late_result_status, late_result_ref, result_ref, error_code FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.create_checkout_session' ORDER BY created_at",
  [id])).rows;
const attempts = async (id) => (await db.app.query("SELECT id, attempt, status, checkout_session_id FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt", [id])).rows;
const sqlErr = (code) => (e) => e.code === code;

// ============================================================================================
// A. Database-controlled time
// ============================================================================================

test("A1: a 2099 timestamp cannot release a future reservation's claim — the caller-time functions no longer exist", async () => {
  const c = await F.confirmed(db.app, { listingId: L(1), from: "2027-03-01", to: "2027-03-05" });
  assert.equal(await active(c.id), 1);
  // BEFORE (E2B.1): release_completed_stays('2099-…') returned 1 and released this claim. AFTER: no such signature.
  await assert.rejects(db.app.query("SELECT booking.release_completed_stays($1::timestamptz)", [FUTURE]), sqlErr("42883"));
  await assert.rejects(db.app.query("SELECT booking.release_claim_if_safe($1, 'X', $2::timestamptz)", [c.id, FUTURE]), sqlErr("42883"));
  await assert.rejects(db.app.query("SELECT booking.claim_release_blockers($1, $2::timestamptz)", [c.id, FUTURE]), sqlErr("42883"));
  // the repository refuses a caller-supplied time outright
  await assert.rejects(releaseCompletedStayClaims(db.app, { now: Date.parse(FUTURE) }), /TIME_IS_DATABASE_CONTROLLED/);
  await assert.rejects(tryReleaseClaim(db.app, c.id, { now: Date.parse(FUTURE) }), /TIME_IS_DATABASE_CONTROLLED/);
  await assert.rejects(claimReleaseBlockers(db.app, c.id, { now: Date.parse(FUTURE) }), /TIME_IS_DATABASE_CONTROLLED/);
  // on the database clock the stay has not happened yet
  assert.equal(await releaseCompletedStayClaims(db.app), 0);
  assert.equal(await tryReleaseClaim(db.app, c.id), false);
  assert.deepEqual(await claimReleaseBlockers(db.app, c.id), ["STAY_NOT_COMPLETED"]);
  assert.equal(await active(c.id), 1, "future reservation keeps its nights");
});

test("A2: privileges cannot bypass the clock — runtime and owner-login are refused; even the schema owner's UPDATE uses database time", async () => {
  const c = await F.confirmed(db.app, { listingId: L(2), from: "2027-03-10", to: "2027-03-12" });
  // runtime role: no UPDATE on claims at all
  await assert.rejects(db.app.query("UPDATE booking.inventory_claims SET released_at = $2, release_reason = 'X' WHERE intent_id = $1", [c.id, FUTURE]), /permission denied/);
  // owner-reconciliation login: no claim writes, no release functions
  await assert.rejects(adminLogin.query("UPDATE booking.inventory_claims SET released_at = $2, release_reason = 'X' WHERE intent_id = $1", [c.id, FUTURE]), /permission denied/);
  await assert.rejects(adminLogin.query("SELECT booking.release_completed_stays()"), /permission denied/);
  await assert.rejects(adminLogin.query("SELECT booking.release_claim_if_safe($1, 'X')", [c.id]), /permission denied/);
  await assert.rejects(adminLogin.query("SELECT booking.purge_guest_data(1, 1)"), /permission denied/);
  // schema owner writing a 2099 release time directly: the trigger re-checks with the DATABASE clock and refuses
  await assert.rejects(db.owner.query("UPDATE booking.inventory_claims SET released_at = $2, release_reason = 'X' WHERE intent_id = $1", [c.id, FUTURE]),
    /CLAIM_RELEASE_BLOCKED: STAY_NOT_COMPLETED/);
  assert.equal(await active(c.id), 1);
  // no booking function accepts a caller time for release or purge any more; PUBLIC executes nothing
  const timeArgs = (await db.owner.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p
      WHERE p.pronamespace = 'booking'::regnamespace AND p.proname IN ('release_completed_stays', 'release_claim_if_safe', 'claim_release_blockers', 'purge_guest_data')`)).rows.map((r) => r.f).sort();
  assert.deepEqual(timeArgs, ["booking.claim_release_blockers(uuid)", "booking.purge_guest_data(integer,integer)",
    "booking.release_claim_if_safe(uuid,text)", "booking.release_completed_stays()"]);
  const publicExec = (await db.owner.query(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace
      AND has_function_privilege('public', p.oid, 'EXECUTE')`)).rows[0].n;
  assert.equal(publicExec, 0);
});

test("A3: authorized release still works for a genuinely completed historical stay; released_at is the database's time", async () => {
  const done = await F.confirmed(db.app, { listingId: L(3), from: "2025-09-01", to: "2025-09-05" });
  const done2 = await F.confirmed(db.app, { listingId: L(4), from: "2025-08-01", to: "2025-08-03" });
  const future = await F.confirmed(db.app, { listingId: L(5), from: "2027-04-01", to: "2027-04-03" });
  assert.deepEqual(await claimReleaseBlockers(db.app, done.id), []);
  const t0 = await dbNow();
  assert.equal(await releaseCompletedStayClaims(db.app), 2);
  const c = await F.claimOf(db.app, done.id);
  assert.equal(c.release_reason, "STAY_COMPLETED");
  assert.ok(Math.abs(new Date(c.released_at).getTime() - t0) < 60_000, "stamped with the database clock, not a caller value");
  assert.equal(await active(done2.id), 0);
  assert.equal(await active(future.id), 1);
  // the schema owner releasing an eligible claim with a forged time still gets the database's time
  const owned = await F.confirmed(db.app, { listingId: L(6), from: "2025-07-01", to: "2025-07-03" });
  await db.owner.query("UPDATE booking.inventory_claims SET released_at = $2, release_reason = 'OWNER_TEST' WHERE intent_id = $1 AND released_at IS NULL", [owned.id, FUTURE]);
  const o = await F.claimOf(db.app, owned.id);
  assert.ok(new Date(o.released_at).getFullYear() < 2099 && Math.abs(new Date(o.released_at).getTime() - (await dbNow())) < 60_000);
});

test("A4: a 2099 timestamp cannot purge guest data early; the caller cannot backdate the audit trail either", async () => {
  const ret = { failedAttemptDays: 30, postCheckoutDays: 90 };
  const failed = await F.pending(db.app, { listingId: L(7), from: "2027-05-01", to: "2027-05-03" });
  await F.sessionExpired(db.app, failed);
  F.ok(await applyEvent(db.app, failed.id, { type: "CHECKOUT_EXPIRED", id: "evt_e2b2_a4" }, { now: F.at(33) }));
  const booked = await F.confirmed(db.app, { listingId: L(8), from: "2027-05-10", to: "2027-05-12" });
  // BEFORE (E2B.1): purge_guest_data('2099-…', 30, 90) deleted both. AFTER: no such signature; the repository refuses "now".
  await assert.rejects(db.app.query("SELECT booking.purge_guest_data($1::timestamptz, 30, 90)", [FUTURE]), sqlErr("42883"));
  await assert.rejects(purgeGuestData(db.app, { now: Date.parse(FUTURE), retention: ret }), /TIME_IS_DATABASE_CONTROLLED/);
  // shortest permitted periods: still nothing of THESE intents is due by the database clock
  await purgeGuestData(db.app, { retention: { failedAttemptDays: 1, postCheckoutDays: 1 } });
  assert.equal(await guests(failed.id), 1, "ended minutes ago by the database clock");
  assert.equal(await guests(booked.id), 1, "check-out is in the future");
  // the runtime cannot forge an old transition time: recorded_at is stamped by the database
  await db.app.query(`INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at, recorded_at)
                      VALUES ($1, 999, 'expired', 'expired', 'FORGED', 'system', '2000-01-01', '2000-01-01')`, [failed.id]);
  const forged = (await db.app.query("SELECT recorded_at FROM booking.intent_transitions WHERE intent_id = $1 AND version_after = 999", [failed.id])).rows[0];
  assert.ok(Math.abs(new Date(forged.recorded_at).getTime() - (await dbNow())) < 60_000);
  await assert.rejects(db.app.query("UPDATE booking.intent_transitions SET recorded_at = '2000-01-01' WHERE intent_id = $1", [failed.id]), /permission denied|not allowed/);
  await purgeGuestData(db.app, { retention: { failedAttemptDays: 1, postCheckoutDays: 1 } });
  assert.equal(await guests(failed.id), 1);
  assert.equal(await guests(booked.id), 1);
});

test("A5: authorized purge still works on genuinely old data (historical check-out; failed attempt that ended 31 days ago)", async () => {
  const ret = { failedAttemptDays: 30, postCheckoutDays: 90 };
  const today = await F.dbToday(db.app, "UTC");
  const old = await F.confirmed(db.app, { listingId: L(9), from: F.addDays(today, -200), to: F.addDays(today, -196) });
  const failed = await F.pending(db.app, { listingId: L(10), from: "2027-05-20", to: "2027-05-22" });
  await F.sessionExpired(db.app, failed);
  F.ok(await applyEvent(db.app, failed.id, { type: "CHECKOUT_EXPIRED", id: "evt_e2b2_a5" }, { now: F.at(33) }));
  await F.ageIntent(db.owner, failed.id, 31);
  assert.equal(await purgeGuestData(db.app, { retention: ret }), 2);
  assert.equal(await guests(old.id), 0);
  assert.equal(await guests(failed.id), 0);
});

// ============================================================================================
// B. Ambiguous Stripe Checkout Session create
// ============================================================================================

test("B1: repeated Pay requests never queue a second create; an unknown create blocks further Pay attempts", async () => {
  const id = await F.withDetails(db.app, { listingId: L(20), from: "2027-06-01", to: "2027-06-03" });
  const a = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  assert.equal(a.reused, false);
  const again = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  assert.equal(again.reused, true);
  assert.equal(again.attempt.id, a.attempt.id);
  const [op0] = await csOps(id);
  assert.deepEqual({ retry_class: op0.retry_class, max_attempts: op0.max_attempts }, { retry_class: "reconcile_first", max_attempts: 1 });
  // a worker sends the create; Stripe's response is lost (timeout)
  const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-b1");
  F.ok(await beginPayStep(db.app, id, { now: F.at(3) }), "while in flight the attempt is reused");
  const r = F.ok(await completeOperation(db.app, op.id, { workerId: "w-b1", now: F.at(3), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  assert.equal(r.state, "outcome_unknown");
  assert.equal((await attempts(id))[0].status, "outcome_unknown");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CHECKOUT_CREATE_OUTCOME_UNKNOWN' AND status = 'open'", [id]), 1);
  for (let i = 0; i < 5; i++) {
    const p = await beginPayStep(db.app, id, { now: F.at(4 + i) });
    assert.equal(p.ok, false);
    assert.equal(p.error, "CHECKOUT_CREATE_UNRESOLVED");
  }
  assert.equal((await csOps(id)).length, 1, "exactly one create ever queued");
  assert.equal((await attempts(id)).length, 1);
  // concurrent Pay requests on a fresh intent: one attempt, one create
  const id2 = await F.withDetails(db.app, { listingId: L(21), from: "2027-06-05", to: "2027-06-07" });
  const results = await Promise.all(Array.from({ length: 8 }, () => beginPayStep(db.app, id2, { now: F.at(2) })));
  assert.ok(results.every((x) => x.ok));
  assert.equal(new Set(results.map((x) => x.attempt.id)).size, 1);
  assert.equal((await csOps(id2)).length, 1);
});

test("B2: a delayed retry (25 hours, 30 days) never re-sends the create; the database refuses re-queue and duplicate rows", async () => {
  const id = await F.withDetails(db.app, { listingId: L(22), from: "2027-06-10", to: "2027-06-12" });
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-b2");
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-b2", now: F.at(3), outcome: { status: "outcome_unknown", errorCode: "HTTP_5XX" } }));
  // BEFORE (E2B.1): the idempotent create went back to pending and was re-claimable after 25 hours. AFTER: never.
  for (const later of [F.at(25 * 60), F.at(30 * 24 * 60), Date.parse(FUTURE)]) {
    await recoverExpiredOperations(db.app, { now: later });
    assert.equal(await claimNextOperation(db.app, { workerId: "w-late", now: later, intentId: id, opTypes: ["stripe.create_checkout_session"] }), null);
  }
  assert.deepEqual((await csOps(id)).map((o) => [o.state, o.attempts]), [["outcome_unknown", 1]]);
  // database guards, whoever asks
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'pending' WHERE id = $1", [op.id]), /OWNER_RESOLUTION_REQUIRED|not allowed/);
  await assert.rejects(db.owner.query("UPDATE booking.external_operations SET state = 'pending' WHERE id = $1", [op.id]), /not allowed/);
  const insertOp = (retryClass, maxAttempts) => db.app.query(
    `INSERT INTO booking.external_operations (id, intent_id, op_type, idempotency_key, retry_class, state, payload, source_version, max_attempts,
       next_attempt_at, created_at, updated_at)
     VALUES ($1, $2, 'stripe.create_checkout_session', $3, $4, 'pending', $5, 99, $6, now(), now(), now())`,
    [randomUUID(), id, `cs-op:${id}:bypass:${retryClass}`, retryClass, { paymentAttemptId: pay.attempt.id }, maxAttempts]);
  await assert.rejects(insertOp("idempotent", 5), /ops_provider_writes_reconcile_first/);
  await assert.rejects(insertOp("reconcile_first", 1), /external_operations_one_open_checkout_create/);
  await assert.rejects(db.app.query(
    `INSERT INTO booking.payment_attempts (id, intent_id, attempt, idempotency_key, status, amount_minor, currency, planned_session_expires_at, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, 2, $2, 'creating', 576000, 'MXN', now(), now(), now())`, [id, `cs:${id}:2`]), /payment_attempts_one_unresolved/);
  // the attempt cannot be opened by assertion either: only for the session a SUCCEEDED create returned
  const opened = await recordCheckoutSession(db.app, id, pay.attempt.id, { sessionId: "cs_test_forged", expiresAt: F.at(32), now: F.at(4) }).catch((e) => e);
  assert.match(String(opened.message || opened.error), /CHECKOUT_CREATE_NOT_VERIFIED/);
});

test("B3: worker interruption — lease expiry makes the create unknown; the late response is kept; a read of that session settles it", async () => {
  const id = await F.withDetails(db.app, { listingId: L(23), from: "2027-06-15", to: "2027-06-17" });
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-crash", 60_000);
  const rec = await recoverExpiredOperations(db.app, { now: F.at(5) });
  assert.deepEqual(rec.filter((x) => x.id === op.id).map((x) => x.state), ["outcome_unknown"]);
  assert.equal(await claimNextOperation(db.app, { workerId: "w-2", now: F.at(6), intentId: id, opTypes: ["stripe.create_checkout_session"] }), null);
  // the crashed worker comes back with Stripe's answer: kept as late evidence, not applied
  const late = await completeOperation(db.app, op.id, { workerId: "w-crash", now: F.at(6), outcome: { status: "succeeded", resultRef: "cs_test_b3" } });
  assert.deepEqual({ ok: late.ok, error: late.error, lateEvidenceRecorded: late.lateEvidenceRecorded }, { ok: false, error: "LEASE_LOST", lateEvidenceRecorded: true });
  const [o] = await csOps(id);
  assert.deepEqual([o.state, o.late_result_status, o.late_result_ref, o.error_code], ["outcome_unknown", "succeeded", "cs_test_b3", "LEASE_EXPIRED"]);
  await assert.rejects(recordCheckoutSession(db.app, id, pay.attempt.id, { sessionId: "cs_test_b3", expiresAt: F.at(32), now: F.at(6) }), /CHECKOUT_CREATE_NOT_VERIFIED/);
  // reconcile: read the session by its id (mocked Stripe read)
  const read = async (minutes, observed, status = "open") => {
    const rid = await requestRead(db.app, id, "stripe.retrieve_checkout_session", "cs_test_b3", { now: F.at(minutes) });
    const ro = await claimNextOperation(db.app, { workerId: "w-read", now: F.at(minutes), intentId: id, opTypes: ["stripe.retrieve_checkout_session"] });
    assert.equal(ro.id, rid);
    F.ok(await completeOperation(db.app, rid, { workerId: "w-read", now: F.at(minutes), outcome: { status: "succeeded", resultRef: "cs_test_b3" } }));
    return F.ok(await recordProviderEvidence(db.app, { readOpId: rid, kind: "checkout_session", externalRef: "cs_test_b3", status, observed })).id;
  };
  const early = await read(3, { paymentAttemptId: pay.attempt.id });
  assert.equal((await settleOperationFromEvidence(db.app, op.id, early)).error, "EVIDENCE_TOO_EARLY");
  const wrong = await read(8, { paymentAttemptId: randomUUID() });
  assert.equal((await settleOperationFromEvidence(db.app, op.id, wrong)).error, "EVIDENCE_REF_MISMATCH", "a session of another attempt proves nothing");
  const good = await read(9, { paymentAttemptId: pay.attempt.id });
  assert.equal(F.ok(await settleOperationFromEvidence(db.app, op.id, good)).state, "succeeded");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id]), 0, "case settled by the same evidence");
  F.ok(await recordCheckoutSession(db.app, id, pay.attempt.id, { sessionId: "cs_test_b3", expiresAt: F.at(32), now: F.at(9) }));
  assert.equal((await loadIntent(db.app, id)).status, "payment_pending");
  assert.equal((await csOps(id)).length, 1, "still exactly one create");
});

test("B4: session id unknown — manual until E5; the owner may settle 'not created' only after the session could no longer be paid (database clock)", async () => {
  // (a) a create made NOW (by the database clock): its session could still be payable for ~30 minutes
  const shift = Math.floor(((await dbNow()) - F.T0) / F.MIN);
  const fresh = await F.withDetails(db.app, { listingId: L(24), from: "2027-07-01", to: "2027-07-03" }, shift);
  const fp = F.ok(await beginPayStep(db.app, fresh, { now: F.at(shift + 2) }));
  const fop = await F.claimOp(db.app, fresh, "stripe.create_checkout_session", F.at(shift + 2), "w-b4a");
  F.ok(await completeOperation(db.app, fop.id, { workerId: "w-b4a", now: F.at(shift + 3), outcome: { status: "outcome_unknown", errorCode: "NETWORK_ERROR" } }));
  const fNone = await F.dashboardEvidence(db.reconciler, fresh, "checkout_session", fp.attempt.id, "none_found",
    { paymentAttemptId: fp.attempt.id, matchingSessionCount: 0 }, shift + 4);
  const tooEarly = await adminResolveOperation(db.reconciler, { operationId: fop.id, decision: "failed_definite", evidenceIds: [fNone],
    resolver: "owner", justification: "NO_SESSION_IN_DASHBOARD", at: F.at(shift + 4) });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /TOO_EARLY/);
  // a caller-supplied resolution time in 2099 does not change that: the check uses the database clock
  const still = await adminResolveOperation(db.reconciler, { operationId: fop.id, decision: "failed_definite", evidenceIds: [fNone],
    resolver: "owner", justification: "NO_SESSION_IN_DASHBOARD", at: Date.parse(FUTURE) });
  assert.match(still.error, /TOO_EARLY/);

  // (b) a create whose planned expiry is long past by the database clock
  const id = await F.withDetails(db.app, { listingId: L(25), from: "2027-07-05", to: "2027-07-07" });
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-b4b");
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-b4b", now: F.at(3), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  // the runtime cannot settle "not created", and cannot call owner functions
  await assert.rejects(db.app.query("SELECT booking.admin_resolve_operation($1, 'failed_definite', '{}'::uuid[], NULL, 'x', 'X', now())", [op.id]), /permission denied/);
  await assert.rejects(db.app.query("UPDATE booking.payment_attempts SET status = 'not_created' WHERE id = $1", [pay.attempt.id]), /not_created requires/);
  // evidence must be about THIS attempt, and a dashboard search (no runtime read can show absence)
  const other = await F.dashboardEvidence(db.reconciler, id, "checkout_session", randomUUID(), "none_found", { paymentAttemptId: randomUUID(), matchingSessionCount: 0 }, 60);
  assert.match((await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "failed_definite", evidenceIds: [other],
    resolver: "owner", justification: "NO_SESSION_IN_DASHBOARD", at: F.at(61) })).error, /INSUFFICIENT_EVIDENCE/);
  await assert.rejects(F.dashboardEvidence(db.reconciler, id, "checkout_session", pay.attempt.id, "none_found", { paymentAttemptId: pay.attempt.id, matchingSessionCount: 1 }, 60));
  const none = await F.dashboardEvidence(db.reconciler, id, "checkout_session", pay.attempt.id, "none_found", { paymentAttemptId: pay.attempt.id, matchingSessionCount: 0 }, 60);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: op.id, decision: "failed_definite", evidenceIds: [none],
    resolver: "owner", justification: "NO_SESSION_IN_DASHBOARD", at: F.at(61) }));
  assert.deepEqual((await csOps(id)).map((o) => [o.state, o.error_code]), [["failed_definite", "RECONCILED_NOT_APPLIED"]]);
  assert.equal((await attempts(id))[0].status, "not_created");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id]), 0);
  // only now may a NEW attempt (new Stripe key) be created (Pay pressed again within the fixture's quote window)
  const next = F.ok(await beginPayStep(db.app, id, { now: F.at(20) }));
  assert.equal(next.reused, false);
  assert.equal(next.attempt.idempotency_key, `cs:${id}:2`);
  assert.equal((await csOps(id)).length, 2);
});

test("B5: an explicit Stripe refusal ends the attempt as not created; ambiguous codes are never accepted as definite", async () => {
  const id = await F.withDetails(db.app, { listingId: L(26), from: "2027-07-10", to: "2027-07-12" });
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-b5");
  for (const code of ["TIMEOUT", "HTTP_5XX", "RATE_LIMITED", "LEASE_EXPIRED"]) {
    const r = await completeOperation(db.app, op.id, { workerId: "w-b5", now: F.at(3), outcome: { status: "failed_definite", errorCode: code } });
    assert.equal(r.error, "AMBIGUOUS_RESULT_NOT_DEFINITE", code);
  }
  F.ok(await completeOperation(db.app, op.id, { workerId: "w-b5", now: F.at(3), outcome: { status: "failed_definite", errorCode: "PARAMETER_INVALID_INTEGER" } }));
  assert.equal((await attempts(id))[0].status, "not_created");
  assert.equal(F.ok(await beginPayStep(db.app, id, { now: F.at(4) })).attempt.attempt, 2);
  assert.notEqual(pay.attempt.id, (await attempts(id))[1].id);
});

test("B6: concurrency — a lease-expiry sweep racing the worker's own completion leaves exactly one outcome and no re-send (repeated)", async () => {
  for (let i = 0; i < 6; i++) {
    const id = await F.withDetails(db.app, { listingId: L(40 + i), from: "2027-08-01", to: "2027-08-03" });
    F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
    const op = await F.claimOp(db.app, id, "stripe.create_checkout_session", F.at(2), "w-race", 60_000);
    const [sweep, done] = await Promise.all([
      recoverExpiredOperations(db.app, { now: F.at(4) }),
      completeOperation(db.app, op.id, { workerId: "w-race", now: F.at(2) + 30_000, outcome: { status: "succeeded", resultRef: `cs_test_race_${i}` } })
    ]);
    const [o] = await csOps(id);
    if (done.ok) assert.equal(o.state, "succeeded");
    else { assert.equal(o.state, "outcome_unknown"); assert.equal(o.late_result_ref, `cs_test_race_${i}`); }
    assert.ok(sweep.filter((x) => x.id === op.id).length <= 1);
    assert.equal(await claimNextOperation(db.app, { workerId: "w-x", now: F.at(60 * 24), intentId: id, opTypes: ["stripe.create_checkout_session"] }), null);
    assert.equal((await csOps(id)).length, 1);
  }
});
