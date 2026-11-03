// Stage E7.4a cross-worker correction — the E7.2 reservation worker uses the accepted phase-guarded orphan re-issue and binds
// its READ_REISSUE_EXHAUSTED escalation to the decided version / state + an in-transaction orphan re-validation.
// Throwaway local PostgreSQL; fake (never-called) providers; overlap proven by an observed PostgreSQL lock wait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead, recordProviderEvidence } from "../../lib/booking-db/operations.js";
import { reissueOrphanRead, MAX_REISSUE_DEPTH, loadRecoveryFacts, applyRecoveryPlan } from "../../lib/booking-db/recovery.js";
import { planRecovery } from "../../lib/checkout/recovery-plan.js";
import { runOrchestratorStep, WORK_STATES } from "../../lib/booking-db/reservation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const MIN = F.MIN;
const L = (n) => 996000 + n;
const LOOKUP = "hostaway.lookup_reservation";
const RETRIEVE = "hostaway.retrieve_reservation";
const PHASE = [...WORK_STATES];
let stayN = 0;
const stay = (n) => { stayN += 1; const d = new Date(Date.UTC(2027, 2, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2027, 2, 1) + (stayN * 6 + 4) * 86400000).toISOString().slice(0, 10); return { listingId: L(n), from: d, to: e }; };

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
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const opsOf = async (id, t) => (await db.app.query("SELECT id, state, payload FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, t])).rows;
const snapAll = async (id) => (await db.app.query("SELECT id, op_type, state, attempts, updated_at FROM booking.external_operations WHERE intent_id = $1 ORDER BY id", [id])).rows;
const caseCount = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1", [id]);
const events = async (id, type) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, type]);
const reasonOf = async (id) => (await db.app.query("SELECT reason_code FROM booking.intents WHERE id = $1", [id])).rows[0].reason_code;
async function crashComplete(opId, t) {
  const c = await claimNextOperation(db.app, { workerId: "w-crash", now: t, opId });
  F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: t, outcome: { status: "succeeded" } }));
}
async function orphanRead(intentId, opType, sel, t) { const rd = await requestRead(db.app, intentId, opType, sel, { now: t }); await crashComplete(rd, t); return rd; }

/** reservation_unknown (the create's outcome unknown; an owner case is opened by E2B), with an E3-queued lookup. */
async function unknownIntent(n) {
  const s = stay(n);
  const d = await F.dispatched(db.app, s);
  const op = await F.claimOp(db.app, d.id, "hostaway.create_reservation", F.at(6));
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "outcome_unknown", errorCode: "TIMEOUT" } }));
  F.ok(await applyEvent(db.app, d.id, { type: "RESERVATION_OUTCOME_UNKNOWN", id: `op-unknown:${op.id}`, code: "TIMEOUT" }, { now: F.at(7), actor: "worker" }));
  assert.equal((await loadIntent(db.app, d.id)).status, "reservation_unknown");
  return { ...d, stay: s, createOpId: op.id };
}
const throwing = () => ({ pricing: { get: async () => { throw new Error("never"); }, post: async () => { throw new Error("never"); } },
  lookupPage: async () => { throw new Error("never"); }, retrieveReservation: async () => { throw new Error("never"); }, createReservation: async () => { throw new Error("never"); } });
const opts = (ns, clock, extra = {}) => ({ workerId: "rw-orphan", env: { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" },
  adapterConfig: validateAdapterConfig({ allowedListingIds: ns.map(L), refFieldId: 777006, channelId: 2000, currency: "MXN" }),
  listings: new Map(ns.map((n) => [L(n), { currency: "MXN" }])), executors: throwing(), clock, ...extra });
const holdWork = (intentId, until) => db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'intruder', work_lease_until = $2 WHERE intent_id = $1", [intentId, new Date(until)]);

// =============================================================================================
test("reservation worker: transition committed before its re-issue (in-phase selection, out-of-phase decision) -> scoped refusal; rows / events / cases unchanged", async () => {
  const d = await unknownIntent(2);
  const orphan = await orphanRead(d.id, RETRIEVE, String(F.nextReservationId()), F.at(10));
  const t = F.at(20);
  await holdWork(d.id, t + 10 * MIN);
  let snap = null; let cases0 = null; let ev0 = null;
  const r = await runOrchestratorStep(db.app, opts([2], () => t, { intentId: d.id, hooks: { beforeReissue: async () => {
    // lawful: a by-ref lookup finds exactly this stay; the accepted planner reconciles reservation_unknown -> reservation_confirmed
    const rid = F.nextReservationId();
    const lk = (await opsOf(d.id, LOOKUP)).find((x) => x.state === "pending");
    const c = await claimNextOperation(db.app, { workerId: "w-other", now: t, opId: lk.id });
    F.ok(await completeOperation(db.app, c.id, { workerId: "w-other", now: t, outcome: { status: "succeeded" } }));
    const res = F.reservationFor(d.stay, rid);
    F.ok(await recordProviderEvidence(db.app, { readOpId: c.id, kind: "hostaway_reservation", externalRef: String(rid), status: "found_active",
      observed: { bookingRef: (await loadIntent(db.app, d.id)).ref, matchCount: 1, reservationId: String(rid), listingId: res.listingId, from: res.from, to: res.to,
        totalMinor: res.totalMinor, currency: res.currency, status: "new" } }));
    // ... and the planner then asks for the by-id read of the found reservation (full identity incl. the ref)
    const byId = await requestRead(db.app, d.id, RETRIEVE, String(rid), { now: t });
    const cb = await claimNextOperation(db.app, { workerId: "w-other", now: t, opId: byId });
    F.ok(await completeOperation(db.app, cb.id, { workerId: "w-other", now: t, outcome: { status: "succeeded" } }));
    F.ok(await recordProviderEvidence(db.app, { readOpId: cb.id, kind: "hostaway_reservation", externalRef: String(rid), status: "found_active",
      observed: { bookingRef: (await loadIntent(db.app, d.id)).ref, reservationId: String(rid), listingId: res.listingId, from: res.from, to: res.to,
        totalMinor: res.totalMinor, currency: res.currency, status: "new" } }));
    const facts = await loadRecoveryFacts(db.app, d.createOpId);
    const plan = planRecovery({ ...facts, now: t });
    assert.equal(plan.event && plan.event.type, "RECONCILED_RESERVATION_FOUND", JSON.stringify(plan));
    F.ok(await applyRecoveryPlan(db.app, plan, { now: t }));
    snap = await snapAll(d.id); cases0 = await caseCount(d.id); ev0 = await events(d.id, "ESCALATE");
  } } }));
  assert.equal((await loadIntent(db.app, d.id)).status, "reservation_confirmed");
  assert.ok(r.actions.includes("RECOVERY:REISSUE!OUT_OF_SCOPE"), JSON.stringify(r.actions));
  assert.deepEqual(await snapAll(d.id), snap, "no read inserted, no row changed after the transition");
  assert.equal((await opsOf(d.id, RETRIEVE)).filter((x) => x.payload.reissueOf === orphan).length, 0);
  assert.equal(await caseCount(d.id), cases0); assert.equal(await events(d.id, "ESCALATE"), ev0);
});

test("reservation worker: transition IN FLIGHT while its re-issue runs (observed lock wait) -> refused after the commit; no out-of-phase read", async () => {
  const d = await unknownIntent(3);
  const rid = String(F.nextReservationId());
  const orphan = await orphanRead(d.id, RETRIEVE, rid, F.at(10));
  const t = F.at(20);
  await holdWork(d.id, t + 10 * MIN);
  const cases0 = await caseCount(d.id);
  const inCommit = deferred(); let evP = null;
  const r = await runOrchestratorStep(db.app, opts([3], () => t, { intentId: d.id, hooks: { beforeReissue: async () => {
    evP = applyEvent(db.app, d.id, { type: "ESCALATE", id: "rw-r1", code: "OWNER_REVIEW" }, { now: t, actor: "reconciler", hooks: { beforeCommit: async () => {
      inCommit.resolve();
      await waitForLockWaiters(1);
    } } });
    await inCommit.promise;
  } } }));
  F.ok(await evP);
  assert.ok(r.actions.includes("RECOVERY:REISSUE!OUT_OF_SCOPE"), JSON.stringify(r.actions));
  assert.equal((await opsOf(d.id, RETRIEVE)).filter((x) => x.payload.reissueOf === orphan).length, 0);
  assert.equal(await events(d.id, "ESCALATE"), 1, "only the other actor's event");
  assert.equal(await caseCount(d.id), cases0 + 1, "only the other actor's case");
});

test("inverse lock order (reservation phase): the scoped re-issue holds the intent first -> inserts in phase; the transition waits, then applies", async () => {
  const d = await unknownIntent(4);
  const orphan = await orphanRead(d.id, RETRIEVE, String(F.nextReservationId()), F.at(10));
  let evP = null;
  const out = await reissueOrphanRead(db.app, orphan, { now: F.at(20), intentStates: PHASE, listingIds: [L(4)], opTypes: [LOOKUP, RETRIEVE], hooks: { afterIntentLock: async () => {
    evP = applyEvent(db.app, d.id, { type: "ESCALATE", id: "rw-inv", code: "OWNER_REVIEW" }, { now: F.at(20), actor: "reconciler" });
    await waitForLockWaiters(1);
  } } });
  assert.equal(out.ok, true, out.error);
  F.ok(await evP);
  assert.equal((await loadIntent(db.app, d.id)).status, "reconciliation_required");
});

test("wrong scope (another intent / unconfigured listing): the reservation worker leaves the out-of-scope orphan and every other row unchanged", async () => {
  const a = await unknownIntent(5);
  const b = await unknownIntent(5);                                             // same listing, other intent
  const c = await unknownIntent(6);                                             // unconfigured listing
  const ob = await orphanRead(b.id, RETRIEVE, String(F.nextReservationId()), F.at(10));
  const oc = await orphanRead(c.id, RETRIEVE, String(F.nextReservationId()), F.at(10));
  const t = F.at(20);
  for (const id of [a.id, b.id, c.id]) await holdWork(id, t + 10 * MIN);
  const sb = await snapAll(b.id); const sc = await snapAll(c.id);
  const r = await runOrchestratorStep(db.app, opts([5], () => t, { intentId: a.id }));
  assert.ok(!r.actions.some((x) => x.startsWith("RECOVERY:REISSUE")), JSON.stringify(r.actions));
  assert.deepEqual(await snapAll(b.id), sb, "other intent untouched");
  assert.deepEqual(await snapAll(c.id), sc, "unconfigured listing untouched");
  // direct helper calls with the worker's scope refuse them too
  assert.deepEqual(await reissueOrphanRead(db.app, ob, { now: t, intentStates: PHASE, listingIds: [L(5)], opTypes: [LOOKUP, RETRIEVE], intentId: a.id }), { ok: false, error: "OUT_OF_SCOPE" });
  assert.deepEqual(await reissueOrphanRead(db.app, oc, { now: t, intentStates: PHASE, listingIds: [L(5)], opTypes: [LOOKUP, RETRIEVE] }), { ok: false, error: "OUT_OF_SCOPE" });
  assert.deepEqual(await snapAll(b.id), sb); assert.deepEqual(await snapAll(c.id), sc);
});

/** A RETRIEVE orphan chain at full depth on a reservation_unknown intent. */
async function exhausted(n) {
  const d = await unknownIntent(n);
  let t = F.at(20);
  const scope = { intentStates: PHASE, listingIds: [L(n)], opTypes: [LOOKUP, RETRIEVE], intentId: d.id };
  let cur = await orphanRead(d.id, RETRIEVE, String(F.nextReservationId()), t);
  for (let k = 1; k <= MAX_REISSUE_DEPTH; k++) {
    t += 3 * MIN;
    const x = await reissueOrphanRead(db.app, cur, { now: t, ...scope });
    assert.equal(x.ok, true, x.error);
    await crashComplete(x.readOpId, t);
    cur = x.readOpId;
  }
  return { d, t: t + 3 * MIN };
}

test("reservation worker exhaustion: a same-phase version change or a superseded orphan before the escalation -> refused; a fresh decision opens the existing owner case", async () => {
  const a = await exhausted(7);
  await holdWork(a.d.id, a.t + 60 * MIN);
  const cases0 = await caseCount(a.d.id);
  const ra = await runOrchestratorStep(db.app, opts([7], () => a.t, { intentId: a.d.id, hooks: { afterReissueExhausted: async () => {
    // another reconciler: same state (reservation_unknown), newer version
    F.ok(await applyEvent(db.app, a.d.id, { type: "RECONCILIATION_INCONCLUSIVE", id: `op-inconclusive:${a.d.createOpId}:other`, code: "OTHER", subject: "reservation" },
      { now: a.t, actor: "reconciler" }));
  } } }));
  assert.ok(ra.actions.includes("RECOVERY:REISSUE!REISSUE_DEPTH_EXHAUSTED") && ra.actions.includes("RECOVERY:ESCALATE!OUT_OF_SCOPE"), JSON.stringify(ra.actions));
  assert.equal((await loadIntent(db.app, a.d.id)).status, "reservation_unknown");
  assert.equal(await events(a.d.id, "ESCALATE"), 0);
  assert.equal(await caseCount(a.d.id), cases0, "no case from the stale decision");
  const ra2 = await runOrchestratorStep(db.app, opts([7], () => a.t + MIN, { intentId: a.d.id }));
  assert.ok(ra2.actions.includes("RECOVERY:ESCALATE:READ_REISSUE_EXHAUSTED"), JSON.stringify(ra2.actions));
  assert.equal(await reasonOf(a.d.id), "READ_REISSUE_EXHAUSTED");
  assert.equal(await caseCount(a.d.id), cases0 + 1, "the existing owner-case policy: one case on the fresh decision");
  // superseded orphan (same version): the depth fact no longer holds
  const b = await exhausted(8);
  await holdWork(b.d.id, b.t + 60 * MIN);
  const last = (await opsOf(b.d.id, RETRIEVE)).at(-1);
  const rb = await runOrchestratorStep(db.app, opts([8], () => b.t, { intentId: b.d.id, hooks: { afterReissueExhausted: async () => {
    await requestRead(db.app, b.d.id, RETRIEVE, last.payload.reservationId, { now: b.t });
  } } }));
  assert.ok(rb.actions.includes("RECOVERY:ESCALATE!OUT_OF_SCOPE"), JSON.stringify(rb.actions));
  assert.equal((await loadIntent(db.app, b.d.id)).status, "reservation_unknown");
});
