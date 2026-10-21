// Stage E2B (+E2B.1) — inventory claims: start at the Pay step (O4), release only when safe, expiry = review, never time-based release.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import {
  applyEvent, beginPayStep, listClaimsDueForReview, deferClaimReview, applyCheckoutSessionEvidence, releaseCompletedStayClaims,
  recoverInterruptedReservations, recordCheckoutSession, tryReleaseClaim, claimReleaseBlockers
} from "../../db/lib/repo.js";
import { claimNextOperation, recoverExpiredOperations } from "../../db/lib/operations.js";
import { adminCloseCase, adminResolveOperation } from "../../db/lib/admin.js";
import { DB_CONFIG } from "../../db/lib/config.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const L = (n) => 710000 + n;
const active = async (listingId) => F.count(db.app, "SELECT count(*) AS n FROM booking.inventory_claims WHERE listing_id = $1 AND released_at IS NULL", [listingId]);

test("O4: browsing, quoting and entering guest details claim nothing; the Pay step claims the nights", async () => {
  const stay = { listingId: L(1), from: "2027-09-01", to: "2027-09-04" };
  const id = await F.withDetails(db.app, stay);
  assert.equal(await active(L(1)), 0, "no claim before Pay");
  const other = await F.withDetails(db.app, stay);
  F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  assert.equal(await active(L(1)), 1);
  assert.equal((await beginPayStep(db.app, other, { now: F.at(2) })).error, "DATES_CLAIMED");
  // repeated Pay click for the same intent reuses the attempt and the claim
  const again = F.ok(await beginPayStep(db.app, id, { now: F.at(3) }));
  assert.equal(again.reused, true);
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.payment_attempts WHERE intent_id = $1", [id]), 1);
});

test("Pay step refuses an expired quote and states other than details_collected", async () => {
  const id = await F.withDetails(db.app, { listingId: L(2), from: "2027-09-01", to: "2027-09-03" });
  assert.equal((await beginPayStep(db.app, id, { now: F.at(31) })).error, "QUOTE_EXPIRED");
  const p = await F.priced(db.app, { listingId: L(2), from: "2027-09-05", to: "2027-09-07" });
  assert.equal((await beginPayStep(db.app, p, { now: F.at(1) })).error, "NOT_READY_FOR_PAYMENT");
  assert.equal(await active(L(2)), 0);
});

test("safe release: a VERIFIED terminal outcome with nothing unresolved releases in the same transaction", async () => {
  const p = await F.pending(db.app, { listingId: L(3), from: "2027-09-01", to: "2027-09-03" });
  // E2B.1 (C3): expiry must be verified by a provider read before it can end the attempt
  assert.equal((await applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_l3_exp" }, { now: F.at(33) })).error, "CHECKOUT_EXPIRY_NOT_VERIFIED");
  assert.equal(await active(L(3)), 1);
  await F.sessionExpired(db.app, p);
  F.ok(await applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_l3_exp" }, { now: F.at(33) }));
  const c = await F.claimOf(db.app, p.id);
  assert.ok(c.released_at, "released");
  assert.equal(c.release_reason, "INTENT_PAYMENT_EXPIRED");
  // nights are free again for the next guest
  const next = await F.withDetails(db.app, { listingId: L(3), from: "2027-09-01", to: "2027-09-03" }, 33);
  F.ok(await beginPayStep(db.app, next, { now: F.at(35) }));
});

test("expiry while a Checkout Session may still exist: claim KEPT, due for evidence review, never released by time", async () => {
  const stay = { listingId: L(4), from: "2027-09-01", to: "2027-09-03" };
  const id = await F.withDetails(db.app, stay);
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));
  // a worker handed the create-session call to Stripe, then crashed: a session may exist
  const csOp = await claimNextOperation(db.app, { workerId: "w-cs", now: F.at(2), intentId: id, opTypes: ["stripe.create_checkout_session"] });
  assert.ok(csOp);
  F.ok(await applyEvent(db.app, id, { type: "EXPIRE" }, { now: F.at(31) })); // quote window over
  assert.equal(await F.state(db.app, id), "expired");
  assert.equal(await active(L(4)), 1, "claim kept: the session could still be paid");
  assert.equal((await db.app.query("SELECT state FROM booking.external_operations WHERE id = $1", [csOp.id])).rows[0].state, "in_flight",
    "a possibly-sent create is never superseded");
  const rival = await F.withDetails(db.app, stay, 30); // a second guest with a valid quote
  assert.equal((await beginPayStep(db.app, rival, { now: F.at(32) })).error, "DATES_CLAIMED");

  // the review sweeper sees it as due, but missing evidence only defers
  // E2B.2: a blocked release no longer pulls review_after back to a caller-supplied time; the claim is due on its own
  // schedule (claimed + claimReviewAfterMs)
  const due = await listClaimsDueForReview(db.app, { now: F.at(2) + DB_CONFIG.claimReviewAfterMs });
  const mine = due.find((d) => d.intent_id === id);
  assert.ok(mine && mine.unresolved_attempts.length === 1);
  assert.ok(mine.blockers.some((b) => b.startsWith("PAYMENT_ATTEMPT_UNRESOLVED")));
  const claimId = (await F.claimOf(db.app, id)).id;
  for (let i = 0; i < DB_CONFIG.maxClaimReviews; i++) F.ok(await deferClaimReview(db.app, claimId, { now: F.at(40 + i * 10) }));
  assert.equal(await active(L(4)), 1, "still held after repeated reviews with no evidence");
  const caseRow = (await db.app.query("SELECT id FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CLAIM_UNRESOLVED' AND status = 'open'", [id])).rows[0];
  assert.ok(caseRow);
  // time alone releases nothing (E2B.2: and no caller can supply a time)
  assert.equal(await tryReleaseClaim(db.app, id), false);
  await assert.rejects(tryReleaseClaim(db.app, id, { now: F.at(60 * 24 * 365) }), /TIME_IS_DATABASE_CONTROLLED/);

  // E2B.2 (B): the interrupted create is NOT replayed. Lease expiry makes it outcome_unknown; it is never claimable again.
  await recoverExpiredOperations(db.app, { now: F.at(100) });
  const after = (await db.app.query("SELECT state, retry_class, attempts FROM booking.external_operations WHERE id = $1", [csOp.id])).rows[0];
  assert.deepEqual(after, { state: "outcome_unknown", retry_class: "reconcile_first", attempts: 1 });
  assert.equal(await claimNextOperation(db.app, { workerId: "w-cs2", now: F.at(500), intentId: id, opTypes: ["stripe.create_checkout_session"] }), null);
  assert.equal(await claimNextOperation(db.app, { workerId: "w-cs3", now: F.at(60 * 24 * 365), intentId: id, opTypes: ["stripe.create_checkout_session"] }), null);
  const unknownCase = (await db.app.query("SELECT id FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CHECKOUT_CREATE_OUTCOME_UNKNOWN' AND status = 'open'", [id])).rows[0];
  assert.ok(unknownCase, "the owner is told");

  // manual until E5: the owner finds the session in the Stripe dashboard and records it; the runtime then reads it by id
  const dash = await F.dashboardEvidence(db.reconciler, id, "checkout_session", "cs_test_l4", "expired", { paymentAttemptId: pay.attempt.id }, 500);
  F.ok(await adminResolveOperation(db.reconciler, { operationId: csOp.id, decision: "succeeded", evidenceIds: [dash], resultRef: "cs_test_l4",
    resolver: "owner", justification: "SESSION_FOUND_IN_DASHBOARD", at: F.at(500) }));
  const prepared = await recordCheckoutSession(db.app, id, pay.attempt.id, { sessionId: "cs_test_l4", expiresAt: F.at(32), now: F.at(500) });
  assert.equal(prepared.error, "ILLEGAL_TRANSITION"); // intent already expired; the session is recorded as evidence anyway
  const ev = await F.readEvidence(db.app, id, "checkout_session", "cs_test_l4", "expired", { paymentAttemptId: pay.attempt.id }, 501);
  const r = F.ok(await applyCheckoutSessionEvidence(db.app, id, pay.attempt.id, ev, { now: F.at(501) }));
  assert.equal(r.released, false, "the open CLAIM_UNRESOLVED case still blocks");
  // owner closes the case citing the same evidence; only then can the database release
  F.ok(await adminCloseCase(db.reconciler, { caseId: caseRow.id, evidenceIds: [ev], resolver: "owner", justification: "SESSION_EXPIRED_UNPAID", at: F.at(502) }));
  assert.equal(await tryReleaseClaim(db.app, id), true);
  assert.equal(await active(L(4)), 0);
  const late = await F.withDetails(db.app, stay, 500);
  F.ok(await beginPayStep(db.app, late, { now: F.at(503) }));
});

test("open session at review time: claim kept and review pushed back; completion must be applied as an authorization", async () => {
  const p = await F.pending(db.app, { listingId: L(5), from: "2027-09-01", to: "2027-09-03" });
  const open = await F.readEvidence(db.app, p.id, "checkout_session", p.sessionId, "open", {}, 20);
  const r = F.ok(await applyCheckoutSessionEvidence(db.app, p.id, p.attemptId, open, { now: F.at(20) }));
  assert.equal(r.deferred, true);
  assert.equal(await active(L(5)), 1);
  const done = await F.readEvidence(db.app, p.id, "checkout_session", p.sessionId, "complete", {}, 25);
  assert.equal((await applyCheckoutSessionEvidence(db.app, p.id, p.attemptId, done, { now: F.at(25) })).error, "APPLY_PAYMENT_AUTHORIZED");
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, "pi_l5", 30), { now: F.at(30) }));
  assert.equal((await F.claimOf(db.app, p.id)).kind, "authorized");
});

test("claims are kept through every uncertain state: reservation_unknown, reservation_failed (void pending), reconciliation_required", async () => {
  // reservation outcome unknown
  const d = await F.dispatched(db.app, { listingId: L(6), from: "2027-09-01", to: "2027-09-03" });
  await recoverInterruptedReservations(db.app, { now: F.at(30) });
  assert.equal(await F.state(db.app, d.id), "reservation_unknown");
  assert.equal(await active(L(6)), 1);
  F.ok(await applyEvent(db.app, d.id, { type: "RECONCILED_RESERVATION_ABSENT" }, { now: F.at(31) }));
  assert.equal(await F.state(db.app, d.id), "reconciliation_required");
  assert.equal(await active(L(6)), 1, "absence unproven -> claim kept");

  // definite refusal: claim kept until the authorization is actually released
  const a = await F.authorized(db.app, { listingId: L(7), from: "2027-09-01", to: "2027-09-03" });
  F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w", recheck: { bookable: false } }, { now: F.at(6) }));
  assert.equal(await F.state(db.app, a.id), "reservation_failed");
  assert.equal(await active(L(7)), 1);
  assert.equal((await applyEvent(db.app, a.id, { type: "VOID_SUCCEEDED" }, { now: F.at(7) })).error, "VOID_NOT_VERIFIED");
  assert.equal(await active(L(7)), 1);
  await F.runOp(db.app, a.id, "stripe.void_payment_intent", 7);
  F.ok(await applyEvent(db.app, a.id, { type: "VOID_SUCCEEDED" }, { now: F.at(7) }));
  assert.equal(await active(L(7)), 0);
});

test("a released claim can never be reactivated; the runtime role cannot touch claims; claims cannot be deleted", async () => {
  const p = await F.pending(db.app, { listingId: L(8), from: "2027-09-01", to: "2027-09-03" });
  await F.sessionExpired(db.app, p);
  F.ok(await applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_l8" }, { now: F.at(33) }));
  const c = await F.claimOf(db.app, p.id);
  assert.ok(c.released_at);
  await assert.rejects(db.app.query("UPDATE booking.inventory_claims SET released_at = NULL, release_reason = NULL WHERE id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.owner.query("UPDATE booking.inventory_claims SET released_at = NULL, release_reason = NULL WHERE id = $1", [c.id]), /cannot be reactivated/);
  await assert.rejects(db.app.query("DELETE FROM booking.inventory_claims WHERE id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.owner.query("DELETE FROM booking.inventory_claims WHERE id = $1", [c.id]), /not allowed/);
});

test("O5 (provisional): a confirmed booking keeps its claim until check-out day in Mexico City (database clock), then releases", async () => {
  // E2B.2: "today" is the database's, in Mexico City. Avoid running across Mexico City midnight.
  const secsToMidnight = Number((await db.app.query(
    "SELECT extract(epoch FROM date_trunc('day', statement_timestamp() AT TIME ZONE 'America/Mexico_City') + interval '1 day' - (statement_timestamp() AT TIME ZONE 'America/Mexico_City')) AS s")).rows[0].s);
  if (secsToMidnight < 90) await new Promise((r) => setTimeout(r, (secsToMidnight + 5) * 1000));
  const mxToday = await F.dbToday(db.app, "America/Mexico_City");
  const leaving = await F.confirmed(db.app, { listingId: L(9), from: F.addDays(mxToday, -2), to: mxToday });          // check-out today
  const staying = await F.confirmed(db.app, { listingId: L(11), from: F.addDays(mxToday, -1), to: F.addDays(mxToday, 1) }); // last night tonight
  assert.equal((await F.claimOf(db.app, leaving.id)).kind, "reserved");
  assert.deepEqual(await claimReleaseBlockers(db.app, staying.id), ["STAY_NOT_COMPLETED"]);
  assert.equal(await releaseCompletedStayClaims(db.app), 1);
  assert.equal(await active(L(9)), 0, "check-out day reached in Mexico City: released");
  assert.equal(await active(L(11)), 1, "the guest's last night is still in progress: kept");
  const released = await F.claimOf(db.app, leaving.id);
  assert.equal(released.release_reason, "STAY_COMPLETED");
  const dbNow = (await db.app.query("SELECT statement_timestamp() AS t")).rows[0].t;
  assert.ok(Math.abs(new Date(released.released_at) - new Date(dbNow)) < 60_000, "released_at is the database's time");
});

test("claims are never released for in-progress money states even if their review time passes", async () => {
  const a = await F.authorized(db.app, { listingId: L(10), from: "2027-09-01", to: "2027-09-03" });
  const claim = await F.claimOf(db.app, a.id);
  F.ok(await deferClaimReview(db.app, claim.id, { now: F.at(10_000) }));
  assert.equal(await active(L(10)), 1);
  assert.equal(await tryReleaseClaim(db.app, a.id), false);
  const blockers = await claimReleaseBlockers(db.app, a.id);
  assert.deepEqual(blockers, ["STATE_NOT_RELEASABLE:payment_authorized"]);
  assert.equal(await active(L(10)), 1);
});
