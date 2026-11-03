// Stage E7.4a correction — phase-guarded orphan re-issue (recovery.js reissueOrphanRead optional scope), used by the cleanup and
// capture workers, and the capture worker's version-bound READ_REISSUE_EXHAUSTED escalation. Throwaway local PostgreSQL;
// overlap is PROVEN by observing a PostgreSQL lock wait (pg_stat_activity), never by a sleep alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation, requestRead } from "../../lib/booking-db/operations.js";
import { findOrphanReads, reissueOrphanRead, MAX_REISSUE_DEPTH } from "../../lib/booking-db/recovery.js";
import { runCleanupStep } from "../../lib/booking-db/compensation-worker.js";
import { runCaptureStep } from "../../lib/booking-db/capture-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const MIN = F.MIN;
const L = (n) => 995000 + n;
const PI_READ = "stripe.retrieve_payment_intent";
const RES_READ = "hostaway.retrieve_reservation";
const CLEANUP = ["reservation_failed", "capture_failed"];
const CAPTURE = ["reservation_confirmed", "capture_unknown"];
let stayN = 0;
const stay = (n) => { stayN += 1; const d = new Date(Date.UTC(2027, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2027, 0, 1) + (stayN * 6 + 4) * 86400000).toISOString().slice(0, 10); return { listingId: L(n), from: d, to: e }; };

/** Poll pg_stat_activity until at least n OTHER backends wait on a lock (bounded). */
async function waitForLockWaiters(n = 1, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    const r = await db.owner.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
                                      AND pid <> pg_backend_pid()`);
    if (r.rows[0].n >= n) return r.rows[0].n;
    if (Date.now() - t0 > timeoutMs) throw new Error(`no lock waiter observed within ${timeoutMs} ms`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const readsOf = async (id, opType = PI_READ) => (await db.app.query("SELECT id, state, payload, created_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at, id", [id, opType])).rows;
const snapAll = async (id) => (await db.app.query("SELECT id, op_type, state, attempts, updated_at FROM booking.external_operations WHERE intent_id = $1 ORDER BY id", [id])).rows;
const casesOf = async (id) => (await db.app.query("SELECT kind, status FROM booking.reconciliation_cases WHERE intent_id = $1 ORDER BY kind", [id])).rows;
const events = async (id, type) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_transitions WHERE intent_id = $1 AND event_type = $2", [id, type]);

/** A succeeded read with no evidence (crash before evidence) = an orphan. */
async function orphanRead(intentId, opType, selector, t) {
  const rd = await requestRead(db.app, intentId, opType, selector, { now: t });
  const c = await claimNextOperation(db.app, { workerId: "w-crash", now: t, opId: rd });
  F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: t, outcome: { status: "succeeded" } }));
  return rd;
}
async function crashComplete(opId, t) {
  const c = await claimNextOperation(db.app, { workerId: "w-crash", now: t, opId });
  F.ok(await completeOperation(db.app, c.id, { workerId: "w-crash", now: t, outcome: { status: "succeeded" } }));
}
async function captureFailedIntent(n) {
  const r = await F.reserved(db.app, stay(n));
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_FAILED", definite: true, code: "CARD_DECLINED" }, { now: F.at(8) }));
  return r;
}
async function captureUnknownIntent(n) {
  const r = await F.reserved(db.app, stay(n));
  const c = (await F.runOp(db.app, r.id, "stripe.capture_payment_intent", 8, { status: "outcome_unknown", errorCode: "TIMEOUT" })).op;
  F.ok(await applyEvent(db.app, r.id, { type: "CAPTURE_OUTCOME_UNKNOWN", id: `op-unknown:${c.id}`, code: "TIMEOUT" }, { now: F.at(8) }));
  // the E3-queued PI read crashes before evidence: an orphan
  const q = (await readsOf(r.id)).find((x) => x.state === "pending");
  await crashComplete(q.id, F.at(9));
  return { ...r, captureOpId: c.id, orphan: q.id };
}

// =============================================================================================
test("default null scope keeps the legacy behaviour (other callers unchanged): the sequential out-of-phase re-issue still inserts", async () => {
  const r = await captureUnknownIntent(1);
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", id: "webhook-cap", amountMinor: 576000, currency: "mxn" }, { now: F.at(19), actor: "webhook" }));
  assert.equal((await loadIntent(db.app, r.id)).status, "payment_captured");
  const legacy = await reissueOrphanRead(db.app, r.orphan, { now: F.at(20) });
  assert.equal(legacy.ok, true, "legacy (unscoped) callers keep the original semantics");
});

test("R2 (sequential): selected in capture_unknown, the intent reaches payment_captured before the re-issue -> scoped refusal, no read inserted", async () => {
  const r = await captureUnknownIntent(2);
  const sel = await findOrphanReads(db.app, { now: F.at(20), intentStates: CAPTURE, intentId: r.id });
  assert.deepEqual(sel.map((x) => x.readOpId), [r.orphan]);
  F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", id: "webhook-cap", amountMinor: 576000, currency: "mxn" }, { now: F.at(19), actor: "webhook" }));
  const before0 = await snapAll(r.id);
  const out = await reissueOrphanRead(db.app, r.orphan, { now: F.at(20), intentStates: CAPTURE, listingIds: [L(2)], opTypes: [PI_READ, RES_READ] });
  assert.deepEqual(out, { ok: false, error: "OUT_OF_SCOPE" });
  assert.deepEqual(await snapAll(r.id), before0, "no row inserted or changed");
});

test("R1 (transition in flight): the re-issue waits on the intent lock while a transition is uncommitted, then sees the new state and refuses", async () => {
  const r = await captureFailedIntent(3);
  const orphan = await orphanRead(r.id, PI_READ, r.piId, F.at(10));
  const before0 = await snapAll(r.id);
  let reissueP = null;
  F.ok(await applyEvent(db.app, r.id, { type: "ESCALATE", id: "r1-escalate", code: "OWNER_REVIEW" }, { now: F.at(20), actor: "reconciler", hooks: { beforeCommit: async () => {
    reissueP = reissueOrphanRead(db.app, orphan, { now: F.at(20), intentStates: CLEANUP, listingIds: [L(3)], opTypes: [PI_READ, RES_READ] });
    await waitForLockWaiters(1);                                  // PROOF of overlap: the re-issue is blocked on the intent lock
  } } }));
  assert.deepEqual(await reissueP, { ok: false, error: "OUT_OF_SCOPE" });
  const after0 = await snapAll(r.id);
  assert.deepEqual(after0.filter((o) => o.op_type === PI_READ), before0.filter((o) => o.op_type === PI_READ), "no out-of-phase read inserted");
});

test("inverse lock ordering: the re-issue holds the intent first (in phase) -> it inserts; the transition waits for it and applies afterwards", async () => {
  const r = await captureFailedIntent(4);
  const orphan = await orphanRead(r.id, PI_READ, r.piId, F.at(10));
  let evP = null;
  const out = await reissueOrphanRead(db.app, orphan, { now: F.at(20), intentStates: CLEANUP, listingIds: [L(4)], opTypes: [PI_READ], hooks: { afterIntentLock: async () => {
    evP = applyEvent(db.app, r.id, { type: "ESCALATE", id: "inv-escalate", code: "OWNER_REVIEW" }, { now: F.at(20), actor: "reconciler" });
    await waitForLockWaiters(1);                                  // the transition is blocked behind our FOR SHARE
  } } });
  assert.equal(out.ok, true, out.error);
  F.ok(await evP);
  assert.equal((await loadIntent(db.app, r.id)).status, "reconciliation_required");
  const re = (await readsOf(r.id)).find((x) => x.id === out.readOpId);
  assert.equal(re.payload.reissueOf, orphan, "inserted while the intent was still in phase (decided under the lock)");
});

test("scope refusals (wrong intent / listing / read type / state) before insert; valid in-phase, de-duplicated and depth-bounded controls", async () => {
  const r = await captureFailedIntent(5);
  const orphan = await orphanRead(r.id, PI_READ, r.piId, F.at(10));
  const before0 = await snapAll(r.id);
  const t = F.at(20);
  const other = await captureFailedIntent(5);
  for (const [scope, label] of [[{ intentId: other.id }, "wrong intent"], [{ listingIds: [L(99)] }, "wrong listing"], [{ opTypes: [RES_READ] }, "wrong read type"],
    [{ intentStates: CAPTURE }, "wrong phase"]]) {
    assert.deepEqual(await reissueOrphanRead(db.app, orphan, { now: t, ...scope }), { ok: false, error: "OUT_OF_SCOPE" }, label);
  }
  assert.deepEqual(await snapAll(r.id), before0, "nothing inserted by any refusal");
  await assert.rejects(reissueOrphanRead(db.app, orphan, { now: t, intentStates: [] }), /invalid scope/);
  // valid in-phase control
  const scope = { intentStates: CLEANUP, listingIds: [L(5)], opTypes: [PI_READ, RES_READ], intentId: r.id };
  const ok1 = await reissueOrphanRead(db.app, orphan, { now: t, ...scope });
  assert.equal(ok1.ok, true);
  // de-duplicated: the orphan is now superseded by its re-issue
  assert.deepEqual(await reissueOrphanRead(db.app, orphan, { now: t, ...scope }), { ok: false, error: "NOT_AN_ORPHAN" });
  assert.equal((await readsOf(r.id)).filter((x) => x.payload.reissueOf === orphan).length, 1);
  // depth bound: re-issued reads that are themselves orphaned, until exhausted (decision carries the intent version / state)
  let cur = ok1.readOpId; let tt = t;
  for (let d = 1; d <= MAX_REISSUE_DEPTH; d++) {
    await crashComplete(cur, tt); tt += 3 * MIN;
    const x = await reissueOrphanRead(db.app, cur, { now: tt, ...scope });
    if (d < MAX_REISSUE_DEPTH) { assert.equal(x.ok, true, `depth ${d}`); cur = x.readOpId; continue; }
    const i = await loadIntent(db.app, r.id);
    assert.deepEqual(x, { ok: false, error: "REISSUE_DEPTH_EXHAUSTED", intentVersion: i.version, intentState: "capture_failed" });
  }
});

// ---- worker level ----
const throwing = (keys) => Object.fromEntries(keys.map((k) => [k, async () => { throw new Error(`${k} must not be called`); }]));
const cleanupOpts = (n, clock, extra = {}) => ({ workerId: "cw-orphan", env: { VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" },
  adapterConfig: validateAdapterConfig({ allowedListingIds: [L(n)], refFieldId: 777005, channelId: 2000, currency: "MXN" }),
  listings: new Map([[L(n), { currency: "MXN", timeZone: "America/Mazatlan" }]]), stripeAccountId: "acct_1OrphanScope", clock,
  executors: throwing(["retrieveAccount", "retrievePaymentIntent", "cancelPaymentIntent", "retrieveReservation", "lookupPage", "cancelReservation"]), ...extra });
const captureOpts = (n, clock, extra = {}) => ({ workerId: "cap-orphan", env: { VERCEL_ENV: "development", MV_E7_CAPTURE_WORKER: "enabled" },
  adapterConfig: validateAdapterConfig({ allowedListingIds: [L(n)], refFieldId: 777005, channelId: 2000, currency: "MXN" }),
  listings: new Map([[L(n), { currency: "MXN" }]]), stripeAccountId: "acct_1OrphanScope", clock,
  executors: throwing(["retrieveAccount", "retrievePaymentIntent", "capturePaymentIntent", "retrieveReservation", "lookupPage"]), ...extra });
const holdWork = (intentId, until) => db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'intruder', work_lease_until = $2 WHERE intent_id = $1", [intentId, new Date(until)]);

test("cleanup worker R1: a transition commits WHILE the worker's re-issue runs -> scoped refusal; no out-of-phase read, event or case", async () => {
  const r = await captureFailedIntent(6);
  const orphan = await orphanRead(r.id, PI_READ, r.piId, F.at(10));
  const t = F.at(20);
  await holdWork(r.id, t + 10 * MIN);                              // only the recovery pass runs
  const cases0 = await casesOf(r.id);
  const inCommit = deferred(); let evP = null;
  const res = await runCleanupStep(db.app, cleanupOpts(6, () => t, { intentId: r.id, hooks: { beforeReissue: async () => {
    evP = applyEvent(db.app, r.id, { type: "ESCALATE", id: "w-r1", code: "OWNER_REVIEW" }, { now: t, actor: "reconciler", hooks: { beforeCommit: async () => {
      inCommit.resolve();
      await waitForLockWaiters(1);                                  // the worker's re-issue is blocked on the intent lock
    } } });
    await inCommit.promise;                                         // the transition is uncommitted, holding the intent row
  } } }));
  F.ok(await evP);
  assert.ok(res.actions.includes("RECOVERY:REISSUE!OUT_OF_SCOPE"), JSON.stringify(res.actions));
  assert.equal((await readsOf(r.id)).filter((x) => x.payload.reissueOf === orphan).length, 0, "no re-issued read");
  assert.equal(await events(r.id, "ESCALATE"), 1, "only the other actor's event");
  assert.deepEqual((await casesOf(r.id)).length, cases0.length + 1, "only the other actor's escalation case");
});

test("capture worker R2: the intent reaches payment_captured before the worker's re-issue -> scoped refusal; no read, event or unrelated change", async () => {
  const r = await captureUnknownIntent(7);
  // the recovery pass first asks the planner, which queues a fresh PI read (superseding the PI orphan): use a reservation-read orphan
  await orphanRead(r.id, RES_READ, String(r.reservationId), F.at(10));
  const t = F.at(20);
  await holdWork(r.id, t + 10 * MIN);
  let snap = null;
  const res = await runCaptureStep(db.app, captureOpts(7, () => t, { intentId: r.id, hooks: { beforeReissue: async () => {
    F.ok(await applyEvent(db.app, r.id, { type: "RECONCILED_CAPTURE_SUCCEEDED", id: "w-r2", amountMinor: 576000, currency: "mxn" }, { now: t, actor: "webhook" }));
    snap = await snapAll(r.id);
  } } }));
  assert.ok(res.actions.includes("RECOVERY:REISSUE!OUT_OF_SCOPE"), JSON.stringify(res.actions));
  assert.deepEqual(await snapAll(r.id), snap, "nothing inserted or changed after the transition");
  assert.equal((await loadIntent(db.app, r.id)).status, "payment_captured");
});

/** A RES-read orphan chain at full depth on a capture_unknown intent (only the recovery pass runs). */
async function exhaustedChain(n) {
  const r = await captureUnknownIntent(n);
  let t = F.at(20);
  const scope = { intentStates: CAPTURE, listingIds: [L(n)], opTypes: [PI_READ, RES_READ], intentId: r.id };
  let cur = await orphanRead(r.id, RES_READ, String(r.reservationId), t);
  for (let d = 1; d <= MAX_REISSUE_DEPTH; d++) {
    t += 3 * MIN;
    const x = await reissueOrphanRead(db.app, cur, { now: t, ...scope });
    assert.equal(x.ok, true);
    await crashComplete(x.readOpId, t);
    cur = x.readOpId;
  }
  return { r, last: cur, t: t + 3 * MIN };
}

test("capture worker exhaustion: a same-phase version change, or a superseded orphan, between the exhaustion result and the escalation -> refused; a fresh decision escalates", async () => {
  // (a) same phase, newer version (another reconciler's RECONCILIATION_INCONCLUSIVE keeps capture_unknown)
  const a = await exhaustedChain(8);
  await holdWork(a.r.id, a.t + 60 * MIN);
  const ra = await runCaptureStep(db.app, captureOpts(8, () => a.t, { intentId: a.r.id, hooks: { beforeReissueEscalate: async () => {
    F.ok(await applyEvent(db.app, a.r.id, { type: "RECONCILIATION_INCONCLUSIVE", id: `op-inconclusive:${a.r.captureOpId}:other`, code: "OTHER", subject: "payment" }, { now: a.t, actor: "reconciler" }));
  } } }));
  assert.ok(ra.actions.includes("RECOVERY:REISSUE!REISSUE_DEPTH_EXHAUSTED") && ra.actions.includes("RECOVERY:ESCALATE!OUT_OF_SCOPE"), JSON.stringify(ra.actions));
  assert.equal((await loadIntent(db.app, a.r.id)).status, "capture_unknown");
  assert.equal(await events(a.r.id, "ESCALATE"), 0);
  // fresh decision on the current version escalates (durable exhaustion preserved)
  const ra2 = await runCaptureStep(db.app, captureOpts(8, () => a.t + MIN, { intentId: a.r.id }));
  assert.ok(ra2.actions.includes("RECOVERY:ESCALATE:READ_REISSUE_EXHAUSTED"), JSON.stringify(ra2.actions));
  assert.equal((await loadIntent(db.app, a.r.id)).status, "reconciliation_required");
  // (b) same version, but the orphan is superseded by a newer read of the same selector -> the depth fact is stale
  const b = await exhaustedChain(9);
  await holdWork(b.r.id, b.t + 60 * MIN);
  const rb = await runCaptureStep(db.app, captureOpts(9, () => b.t, { intentId: b.r.id, hooks: { beforeReissueEscalate: async () => {
    await requestRead(db.app, b.r.id, RES_READ, String(b.r.reservationId), { now: b.t });
  } } }));
  assert.ok(rb.actions.includes("RECOVERY:ESCALATE!OUT_OF_SCOPE"), JSON.stringify(rb.actions));
  assert.equal((await loadIntent(db.app, b.r.id)).status, "capture_unknown");
});
