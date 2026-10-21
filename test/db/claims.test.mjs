// Stage E2B — inventory claims: start at the Pay step (O4), release only when safe, expiry = review, never time-based release.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import {
  applyEvent, beginPayStep, listClaimsDueForReview, deferClaimReview, resolveCheckoutEvidence, releaseCompletedStayClaims,
  recoverInterruptedReservations
} from "../../db/lib/repo.js";
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

test("safe release: a definite terminal outcome with no unresolved payment attempt releases in the same transaction", async () => {
  const p = await F.pending(db.app, { listingId: L(3), from: "2027-09-01", to: "2027-09-03" });
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
  const pay = F.ok(await beginPayStep(db.app, id, { now: F.at(2) }));      // Stripe call outcome unknown (crash)
  F.ok(await applyEvent(db.app, id, { type: "EXPIRE" }, { now: F.at(31) })); // quote window over
  assert.equal(await F.state(db.app, id), "expired");
  assert.equal(await active(L(4)), 1, "claim kept: the session could still be paid");
  const rival = await F.withDetails(db.app, stay, 30); // a second guest with a valid quote
  assert.equal((await beginPayStep(db.app, rival, { now: F.at(32) })).error, "DATES_CLAIMED");

  // the review sweeper sees it as due, but missing/unclear evidence only defers
  const due = await listClaimsDueForReview(db.app, { now: F.at(31) });
  const mine = due.find((d) => d.intent_id === id);
  assert.ok(mine && mine.unresolved_attempts.length === 1);
  for (let i = 0; i < DB_CONFIG.maxClaimReviews; i++) {
    F.ok(await resolveCheckoutEvidence(db.app, id, pay.attempt.id, { sessionStatus: "unknown" }, { now: F.at(40 + i * 10) }));
  }
  assert.equal(await active(L(4)), 1, "still held after repeated reviews with no evidence");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'CLAIM_UNRESOLVED' AND status = 'open'", [id]), 1);

  // years later, time alone still releases nothing
  assert.equal(await active(L(4)), 1);
  // provider evidence: the session expired unpaid -> safe release
  F.ok(await resolveCheckoutEvidence(db.app, id, pay.attempt.id, { sessionStatus: "expired", sessionId: "cs_test_l4" }, { now: F.at(500) }));
  assert.equal(await active(L(4)), 0);
  const late = await F.withDetails(db.app, stay, 500);
  F.ok(await beginPayStep(db.app, late, { now: F.at(502) }));
});

test("open session at review time: claim kept and review pushed back", async () => {
  const p = await F.pending(db.app, { listingId: L(5), from: "2027-09-01", to: "2027-09-03" });
  const r = F.ok(await resolveCheckoutEvidence(db.app, p.id, p.attemptId, { sessionStatus: "open", sessionId: p.sessionId }, { now: F.at(45) }));
  assert.equal(r.deferred, true);
  assert.equal(await active(L(5)), 1);
  // completed session: this helper refuses to guess; the verified authorization must be applied as an E3 event
  assert.equal((await resolveCheckoutEvidence(db.app, p.id, p.attemptId, { sessionStatus: "complete" }, { now: F.at(46) })).error, "APPLY_PAYMENT_AUTHORIZED");
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
  F.ok(await applyEvent(db.app, a.id, { type: "VOID_SUCCEEDED" }, { now: F.at(7) }));
  assert.equal(await active(L(7)), 0);
});

test("a released claim can never be reactivated; claims cannot be deleted", async () => {
  const p = await F.pending(db.app, { listingId: L(8), from: "2027-09-01", to: "2027-09-03" });
  F.ok(await applyEvent(db.app, p.id, { type: "CHECKOUT_EXPIRED", id: "evt_l8" }, { now: F.at(33) }));
  const c = await F.claimOf(db.app, p.id);
  await assert.rejects(db.app.query("UPDATE booking.inventory_claims SET released_at = NULL, release_reason = NULL WHERE id = $1", [c.id]), /cannot be reactivated/);
  await assert.rejects(db.app.query("DELETE FROM booking.inventory_claims WHERE id = $1", [c.id]), /permission denied/);
  await assert.rejects(db.owner.query("DELETE FROM booking.inventory_claims WHERE id = $1", [c.id]), /not allowed/);
});

test("O5 (provisional): a confirmed booking keeps its claim until check-out, then releases", async () => {
  const c = await F.confirmed(db.app, { listingId: L(9), from: "2027-09-01", to: "2027-09-03" });
  assert.equal((await F.claimOf(db.app, c.id)).kind, "reserved");
  assert.equal(await releaseCompletedStayClaims(db.app, { today: "2027-09-02", now: F.at(1) }), 0);
  assert.equal(await active(L(9)), 1);
  assert.equal(await releaseCompletedStayClaims(db.app, { today: "2027-09-03", now: F.at(2) }), 1);
  assert.equal(await active(L(9)), 0);
});

test("claims are never released for in-progress money states even if their review time passes", async () => {
  const a = await F.authorized(db.app, { listingId: L(10), from: "2027-09-01", to: "2027-09-03" });
  const claim = await F.claimOf(db.app, a.id);
  F.ok(await deferClaimReview(db.app, claim.id, { now: F.at(10_000) }));
  assert.equal(await active(L(10)), 1);
  const r = await resolveCheckoutEvidence(db.app, a.id, a.attemptId, { sessionStatus: "expired", sessionId: a.sessionId }, { now: F.at(10_001) });
  assert.equal(r.released, false, "authorized intent keeps its claim even with session evidence");
  assert.equal(await active(L(10)), 1);
});
