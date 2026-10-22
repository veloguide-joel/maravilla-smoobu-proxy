// Stage E2B — transactional outbox: atomic with transitions, single claimant, lease recovery by retry class,
// no external dispatch enabled.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntentRow } from "../../db/lib/repo.js";
import {
  claimNextOperation, completeOperation, recoverExpiredOperations, dispatchOperation, EXTERNAL_DISPATCH_ENABLED
} from "../../db/lib/operations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });
const VOID = ["stripe.void_payment_intent"];
const opRow = async (id) => (await db.app.query("SELECT * FROM booking.external_operations WHERE id = $1", [id])).rows[0];

test("effects are written in the same transaction as the transition (all or nothing)", async () => {
  const a = await F.authorized(db.app, { listingId: 730001 });
  const v = (await loadIntentRow(db.app, a.id)).version;
  const opsBefore = await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1", [a.id]);
  await assert.rejects(applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false } },
    { now: F.at(6), inTx: async () => { throw new Error("simulated crash before commit"); } }), /simulated crash/);
  assert.equal((await loadIntentRow(db.app, a.id)).version, v, "no version change");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1", [a.id]), opsBefore, "no void op");
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1", [a.id]), v + 1, "no audit row");
  const r = F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false } }, { now: F.at(6) }));
  assert.deepEqual(r.operations.map((o) => o.opType), ["stripe.void_payment_intent"]);
  const op = await opRow(r.operations[0].id);
  assert.equal(op.payload.providerIdempotencyKey, `void:${a.id}:${a.piId}`, "Stripe idempotency key from E3 travels with the op");
  assert.equal(op.state, "pending");
});

test("duplicate dispatch attempts: 6 workers race for one operation -> exactly one claim; in-flight is not re-claimable", async () => {
  const a = await F.authorized(db.app, { listingId: 730002 });
  const r = F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false } }, { now: F.at(6) }));
  const opId = r.operations[0].id;
  // six workers issue the claim statement at the same time; FOR UPDATE SKIP LOCKED hands the row to exactly one
  const claims = await Promise.all([...Array(6).keys()].map((i) => claimNextOperation(db.app, {
    workerId: `w${i}`, now: F.at(7), intentId: a.id, opTypes: VOID })));
  const got = claims.filter(Boolean);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, opId);
  assert.equal(await claimNextOperation(db.app, { workerId: "w9", now: F.at(7.5), intentId: a.id, opTypes: VOID }), null, "in flight with a live lease");
  // the lease holder completes; a stale or foreign worker cannot
  assert.equal((await completeOperation(db.app, opId, { workerId: "wX", now: F.at(7.5), outcome: { status: "succeeded" } })).error, "LEASE_LOST");
  F.ok(await completeOperation(db.app, opId, { workerId: got[0].lease_worker_id, now: F.at(7.5), outcome: { status: "succeeded", resultRef: a.piId } }));
  assert.equal((await opRow(opId)).state, "succeeded");
  assert.equal(await claimNextOperation(db.app, { workerId: "w9", now: F.at(100), intentId: a.id, opTypes: VOID }), null, "completed ops are never claimed again");
});

test("worker interruption: expired leases are recovered according to retry class", async () => {
  // reconcile_first (Stripe void): an interrupted call is NEVER re-queued — outcome_unknown, settled only by a read
  const a = await F.authorized(db.app, { listingId: 730003 });
  const r = F.ok(await applyEvent(db.app, a.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false } }, { now: F.at(6) }));
  const voidOp = await claimNextOperation(db.app, { workerId: "w1", now: F.at(7), intentId: a.id, opTypes: VOID, leaseMs: 60000 });
  assert.equal(voidOp.id, r.operations[0].id);
  // read (lookup) op from another intent: safe to repeat
  const d = await F.authorized(db.app, { listingId: 730004 });
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_STARTED", workerId: "w2", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), workerId: "w2" }));
  const lookupOp = await claimNextOperation(db.app, { workerId: "w2", now: F.at(7), intentId: d.id, opTypes: ["hostaway.lookup_reservation"], leaseMs: 60000 });
  assert.equal(lookupOp.op_type, "hostaway.lookup_reservation");
  // both workers die; leases expire
  const rec = await recoverExpiredOperations(db.app, { now: F.at(9) });
  const byId = Object.fromEntries(rec.map((x) => [x.id, x.state]));
  assert.equal(byId[voidOp.id], "outcome_unknown", "E3.2: an interrupted void is not re-sent");
  assert.equal(byId[lookupOp.id], "pending");
  assert.equal(await claimNextOperation(db.app, { workerId: "w3", now: F.at(100), intentId: a.id, opTypes: VOID }), null);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET state = 'pending' WHERE id = $1", [voidOp.id]), /not allowed/);
  // a worker that comes back late cannot complete
  assert.equal((await completeOperation(db.app, voidOp.id, { workerId: "w1", now: F.at(9.5), outcome: { status: "succeeded" } })).error, "LEASE_LOST");
});

test("retry limits: idempotent ops escalate after max attempts; reconcile-first writes allow exactly one attempt", async () => {
  const a = await F.authorized(db.app, { listingId: 730005 });
  const e = F.ok(await applyEvent(db.app, a.id, { type: "ESCALATE", code: "MANUAL_REVIEW" }, { now: F.at(6) }));
  const alertId = e.operations.find((o) => o.opType === "alert.owner").id;
  let t = 10;
  for (let i = 0; i < 5; i++) {
    const op = await claimNextOperation(db.app, { workerId: "w1", now: F.at(t), intentId: a.id, opTypes: ["alert.owner"] });
    assert.equal(op.id, alertId);
    const c = F.ok(await completeOperation(db.app, alertId, { workerId: "w1", now: F.at(t), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
    assert.equal(c.state, i < 4 ? "pending" : "escalated");
    t += 5;
  }
  assert.equal(await F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'OPERATION_RETRIES_EXHAUSTED'", [a.id]), 1);
  await assert.rejects(db.app.query("UPDATE booking.external_operations SET attempts = 6 WHERE id = $1", [alertId]), /check constraint/);
  const b = await F.authorized(db.app, { listingId: 730006 });
  const v = F.ok(await applyEvent(db.app, b.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: false } }, { now: F.at(6) }));
  const voidRow = (await db.app.query("SELECT retry_class, max_attempts FROM booking.external_operations WHERE id = $1", [v.operations[0].id])).rows[0];
  assert.deepEqual(voidRow, { retry_class: "reconcile_first", max_attempts: 1 });
  await assert.rejects(db.owner.query("UPDATE booking.external_operations SET max_attempts = 3 WHERE id = $1", [v.operations[0].id]), /immutable|check constraint/);
});

test("external dispatch is disabled: no executor, no send; no route imports the booking database layer", async () => {
  assert.equal(EXTERNAL_DISPATCH_ENABLED, false);
  await assert.rejects(dispatchOperation({ op_type: "hostaway.create_reservation" }), (e) => e.code === "DISPATCH_DISABLED");
  await assert.rejects(dispatchOperation({ op_type: "stripe.capture_payment_intent" }, { executors: {} }), (e) => e.code === "DISPATCH_DISABLED");
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
  // deployable code (api/ and the lib/ it imports) never references the booking database layer
  for (const f of [...walk("api"), ...walk("lib")]) assert.doesNotMatch(readFileSync(f, "utf8"), /db\/lib|booking_migrations|BOOKING_DATABASE_URL|db\/migrations/, f);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["dotenv", "pg", "stripe"], "no new dependency");
});
