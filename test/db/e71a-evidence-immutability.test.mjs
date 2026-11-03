// Stage E7.1a — settled evidence is immutable (migration 0008). Throwaway local PostgreSQL; fake providers; runtime code
// runs as mv_booking_app, owner resolution as mv_booking_admin, schema owner as the cluster superuser.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent } from "../../lib/booking-db/repo.js";
import { settleOperationFromEvidence, reportUnknownOutcome } from "../../lib/booking-db/operations.js";
import { adminResolveOperation } from "../../db/lib/admin.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const L = (n) => 830000 + n;
const CAP = "stripe.capture_payment_intent";
const opRow = async (id) => (await db.app.query("SELECT state, settled_evidence_id, resolution_id FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const IMMUTABLE = /SETTLED_EVIDENCE_IMMUTABLE/;

/** An ambiguous capture with two fresh PI reads recorded (ev1 earlier, ev2 later). */
async function ambiguousCapture(n) {
  const r = await F.reserved(db.app, { listingId: L(n) });
  const { op } = await F.runOp(db.app, r.id, CAP, 8, { status: "outcome_unknown", errorCode: "TIMEOUT" });
  F.ok(await reportUnknownOutcome(db.app, op.id, { now: F.at(9) }));                   // capture_unknown (+ E3's PI read)
  const ev1 = await F.piStatus(db.app, r.id, r.piId, "requires_capture", { amountReceivedMinor: 0 }, 12);
  const ev2 = await F.piStatus(db.app, r.id, r.piId, "requires_capture", { amountReceivedMinor: 0 }, 13);
  return { ...r, op, ev1, ev2 };
}

test("legitimate NULL -> first evidence settlement still succeeds (runtime settler); re-writing the same id is a no-op", async () => {
  const c = await ambiguousCapture(1);
  assert.equal((await opRow(c.op.id)).settled_evidence_id, null);
  assert.deepEqual(F.ok(await settleOperationFromEvidence(db.app, c.op.id, c.ev1)).state, "failed_definite");
  assert.equal((await opRow(c.op.id)).settled_evidence_id, c.ev1);
  for (const pool of [db.app, db.reconciler, db.owner]) {
    await pool.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [c.op.id, c.ev1]).catch((e) => {
      if (IMMUTABLE.test(e.message)) throw e;                                   // only a non-immutability refusal (privileges) may occur
    });
  }
  assert.equal((await opRow(c.op.id)).settled_evidence_id, c.ev1);
  // the recovery flow continues normally on top of the settled row
  F.ok(await applyEvent(db.app, c.id, { type: "RECONCILED_STILL_AUTHORIZED", id: "imm-1" }, { now: F.at(14) }));
});

test("clear or repoint is refused for every role, on same-state updates and after completion", async () => {
  const c = await ambiguousCapture(2);
  F.ok(await settleOperationFromEvidence(db.app, c.op.id, c.ev1));
  const st = (await opRow(c.op.id)).state;
  for (const [name, pool] of [["runtime", db.app], ["owner superuser", db.owner]]) {
    await assert.rejects(pool.query("UPDATE booking.external_operations SET settled_evidence_id = NULL WHERE id = $1", [c.op.id]), IMMUTABLE, `${name} clear`);
    await assert.rejects(pool.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [c.op.id, c.ev2]), IMMUTABLE, `${name} repoint`);
    // combined with other column changes in the same statement
    await assert.rejects(pool.query("UPDATE booking.external_operations SET settled_evidence_id = $2, updated_at = now() WHERE id = $1", [c.op.id, c.ev2]), IMMUTABLE, `${name} repoint+touch`);
  }
  // the admin login cannot write the table directly at all (unchanged privileges), and has no path that repoints it
  await assert.rejects(db.reconciler.query("UPDATE booking.external_operations SET settled_evidence_id = NULL WHERE id = $1", [c.op.id]), /permission denied|SETTLED_EVIDENCE_IMMUTABLE/);
  // the settler itself refuses a second settlement (state no longer outcome_unknown)
  assert.equal((await settleOperationFromEvidence(db.app, c.op.id, c.ev2)).error, "NOT_SETTLEABLE");
  assert.deepEqual(await opRow(c.op.id), { state: st, settled_evidence_id: c.ev1, resolution_id: null });
  // after further progress (a new capture attempt exists), the old row's evidence is still pinned
  F.ok(await applyEvent(db.app, c.id, { type: "RECONCILED_STILL_AUTHORIZED", id: "imm-2" }, { now: F.at(14) }));
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [c.op.id, c.ev2]), IMMUTABLE);
  // a bulk update touching the settled row fails as a whole (no partial repoint)
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET settled_evidence_id = NULL WHERE intent_id = $1", [c.id]), IMMUTABLE);
  assert.equal((await opRow(c.op.id)).settled_evidence_id, c.ev1);
});

test("unrelated updates of a settled row (same evidence) are not affected", async () => {
  const c = await ambiguousCapture(3);
  F.ok(await settleOperationFromEvidence(db.app, c.op.id, c.ev1));
  await db.app.query("UPDATE booking.external_operations SET updated_at = now() WHERE id = $1", [c.op.id]);
  assert.equal((await opRow(c.op.id)).settled_evidence_id, c.ev1);
});

test("concurrent settlements with DIFFERENT evidence: exactly one wins and its evidence stays pinned", async () => {
  for (let k = 0; k < 6; k++) {
    const c = await ambiguousCapture(10 + k);
    const [a, b] = await Promise.all([settleOperationFromEvidence(db.app, c.op.id, c.ev1), settleOperationFromEvidence(db.app, c.op.id, c.ev2)]);
    const winners = [[a, c.ev1], [b, c.ev2]].filter(([x]) => x.ok);
    assert.equal(winners.length, 1, JSON.stringify([a, b]));
    assert.equal([a, b].find((x) => !x.ok).error, "NOT_SETTLEABLE");
    const pinned = winners[0][1];
    assert.equal((await opRow(c.op.id)).settled_evidence_id, pinned);
    const other = pinned === c.ev1 ? c.ev2 : c.ev1;
    await assert.rejects(db.app.query("UPDATE booking.external_operations SET settled_evidence_id = $2 WHERE id = $1", [c.op.id, other]), IMMUTABLE);
    assert.equal((await opRow(c.op.id)).settled_evidence_id, pinned);
  }
});

test("owner resolution of an ambiguous operation is unchanged (it never touches settled evidence)", async () => {
  const c = await ambiguousCapture(20);
  const r = await adminResolveOperation(db.reconciler, { operationId: c.op.id, decision: "failed_definite", evidenceIds: [c.ev1],
    resolver: "owner-test", justification: "STRIPE_SHOWS_REQUIRES_CAPTURE", at: F.at(30) });
  F.ok(r, "owner resolution with Stripe API evidence");
  const row = await opRow(c.op.id);
  assert.deepEqual([row.state, row.settled_evidence_id, row.resolution_id !== null], ["failed_definite", null, true]);
  // once resolved by the owner, a runtime settlement can no longer attach evidence (not outcome_unknown)
  assert.equal((await settleOperationFromEvidence(db.app, c.op.id, c.ev2)).error, "NOT_SETTLEABLE");
});
