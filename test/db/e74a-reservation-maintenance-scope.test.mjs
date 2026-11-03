// Stage E7.4a cross-worker correction — the E7.2 reservation worker's expired-lease maintenance is phase-guarded
// (recoverExpiredOperations intentStates: its WORK_STATES). Throwaway local PostgreSQL; executors that record and refuse
// every call; overlap proven by an observed PostgreSQL lock wait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead } from "../../lib/booking-db/operations.js";
import { runOrchestratorStep } from "../../lib/booking-db/reservation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const MIN = F.MIN;
const L = (n) => 997000 + n;
const LOOKUP = "hostaway.lookup_reservation";
const RETRIEVE = "hostaway.retrieve_reservation";
let stayN = 0;
const stay = (n) => { stayN += 1; const d = new Date(Date.UTC(2027, 4, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2027, 4, 1) + (stayN * 6 + 4) * 86400000).toISOString().slice(0, 10); return { listingId: L(n), from: d, to: e }; };

async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                                      AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
const row = async (id) => (await db.app.query("SELECT state, lease_worker_id, lease_until, attempts, error_code, updated_at FROM booking.external_operations WHERE id = $1", [id])).rows[0];
const snapIntent = async (id) => ({
  ops: (await db.app.query("SELECT id, state, attempts, updated_at FROM booking.external_operations WHERE intent_id = $1 ORDER BY id", [id])).rows,
  intent: (await db.app.query("SELECT state, version FROM booking.intents WHERE id = $1", [id])).rows[0],
  events: (await db.app.query("SELECT count(*)::int AS n FROM booking.intent_transitions WHERE intent_id = $1", [id])).rows[0].n,
  cases: (await db.app.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1", [id])).rows[0].n
});
/** A read row claimed by a crashed worker whose lease is long expired (still in_flight). */
async function expiredInFlight(intentId, opType, sel, t) {
  const id = await requestRead(db.app, intentId, opType, sel, { now: t });
  assert.ok(await claimNextOperation(db.app, { workerId: "x-crashed", now: t, opId: id }));
  return id;
}
/** reservation_unknown (create outcome unknown), with its E3-queued lookup drained so only our rows are in flight. */
async function unknownIntent(n) {
  const d = await F.dispatched(db.app, stay(n));
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_OUTCOME_UNKNOWN", id: `op-unknown:${op.id}`, code: "TIMEOUT" }, { now: F.at(7), actor: "worker" }));
  return d;
}
/** Lawfully left the reservation phase: the create's 201 recorded -> reservation_confirmed (as fixtures.reserved). */
async function confirmedWithExpiredLookup(n) {
  const s = stay(n);
  const d = await F.dispatched(db.app, s);
  const lk = (await db.app.query("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND state = 'pending'", [d.id, LOOKUP])).rows[0].id;
  assert.ok(await claimNextOperation(db.app, { workerId: "x-crashed", now: F.at(6), opId: lk }));          // in flight; lease expires at +1 min
  const rid = F.nextReservationId();
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(db.app, d.id, { httpStatus: 201, reservation: F.reservationFor(s, rid) }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(s, rid) }, { now: F.at(7), actor: "worker" }));
  assert.equal((await loadIntent(db.app, d.id)).status, "reservation_confirmed");
  return { ...d, lookup: lk };
}
function recorder() {
  const calls = [];
  const no = (k) => async () => { calls.push(k); throw new Error(`${k} must not be called`); };
  return { calls, executors: { pricing: { get: no("pricing.get"), post: no("pricing.post") }, lookupPage: no("lookupPage"), retrieveReservation: no("retrieveReservation"),
    createReservation: no("createReservation") } };
}
const opts = (ns, clock, rec, extra = {}) => ({ workerId: "rw-maint", env: { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" },
  adapterConfig: validateAdapterConfig({ allowedListingIds: ns.map(L), refFieldId: 777007, channelId: 2000, currency: "MXN" }),
  listings: new Map(ns.map((n) => [L(n), { currency: "MXN" }])), executors: rec.executors, clock, ...extra });
const holdWork = (intentId, until) => db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'intruder', work_lease_until = $2 WHERE intent_id = $1", [intentId, new Date(until)]);

// =============================================================================================
test("an expired in-flight lookup of an intent that LEFT the reservation phase is untouched; an in-phase expired read still recovers", async () => {
  const out = await confirmedWithExpiredLookup(1);
  const inp = await unknownIntent(1);
  const rd = await expiredInFlight(inp.id, RETRIEVE, String(F.nextReservationId()), F.at(8));
  const t = F.at(30);
  for (const id of [out.id, inp.id]) await holdWork(id, t + 10 * MIN);         // maintenance only (no handler work)
  const s0 = await snapIntent(out.id);
  const rec = recorder();
  // unscoped (by intent) step over the configured listing
  await runOrchestratorStep(db.app, opts([1], () => t, rec));
  assert.deepEqual(await snapIntent(out.id), s0, "out-of-phase intent: rows / events / cases unchanged");
  assert.equal((await row(out.lookup)).state, "in_flight");
  const r = await row(rd);
  assert.deepEqual([r.state, r.error_code], ["pending", "LEASE_EXPIRED"], "in-phase expired read recovered as before (read retry)");
  assert.deepEqual(rec.calls, [], "no provider call");
});

test("wrong listing / intent / operation type: expired rows outside the worker's scope stay untouched", async () => {
  const a = await unknownIntent(2);
  const other = await unknownIntent(2);                                           // same listing, another intent
  const unconfigured = await unknownIntent(3);
  const t0 = F.at(8);
  const ra = await expiredInFlight(a.id, RETRIEVE, String(F.nextReservationId()), t0);
  const ro = await expiredInFlight(other.id, RETRIEVE, String(F.nextReservationId()), t0);
  const ru = await expiredInFlight(unconfigured.id, RETRIEVE, String(F.nextReservationId()), t0);
  const rt = await expiredInFlight(a.id, "stripe.retrieve_payment_intent", a.piId, t0);   // not a reservation-worker op type
  const t = F.at(30);
  for (const id of [a.id, other.id, unconfigured.id]) await holdWork(id, t + 10 * MIN);
  const so = await snapIntent(other.id); const su = await snapIntent(unconfigured.id);
  const rt0 = await row(rt);
  const rec = recorder();
  await runOrchestratorStep(db.app, opts([2], () => t, rec, { intentId: a.id }));
  assert.equal((await row(ra)).state, "pending", "the scoped intent's in-phase read recovered");
  assert.deepEqual(await snapIntent(other.id), so, "other intent untouched");
  assert.deepEqual(await snapIntent(unconfigured.id), su, "unconfigured listing untouched");
  assert.deepEqual(await row(rt), rt0, "other operation type untouched");
  assert.equal((await row(ro)).state, "in_flight"); assert.equal((await row(ru)).state, "in_flight");
  assert.deepEqual(rec.calls, []);
});

test("concurrent phase transition: maintenance blocks on the intent lock held by an uncommitted transition (observed), then sees the new state and leaves the row", async () => {
  const d = await unknownIntent(4);
  const rd = await expiredInFlight(d.id, RETRIEVE, String(F.nextReservationId()), F.at(8));
  const t = F.at(30);
  await holdWork(d.id, t + 10 * MIN);
  const rec = recorder();
  let stepP = null;
  // the op row is NOT locked by the transition, so SKIP LOCKED on the operation cannot hide it: only the intent lock serialises
  F.ok(await applyEvent(db.app, d.id, { type: "ESCALATE", id: "maint-race", code: "OWNER_REVIEW" }, { now: t, actor: "reconciler", hooks: { beforeCommit: async () => {
    stepP = runOrchestratorStep(db.app, opts([4], () => t, rec, { intentId: d.id }));
    await waitForLockWaiters(1);
  } } }));
  await stepP;
  assert.equal((await loadIntent(db.app, d.id)).status, "reconciliation_required");
  const r = await row(rd);
  assert.deepEqual([r.state, r.lease_worker_id, r.error_code], ["in_flight", "x-crashed", null], "left exactly as it was (out of phase when decided)");
  assert.deepEqual(rec.calls, []);
});
