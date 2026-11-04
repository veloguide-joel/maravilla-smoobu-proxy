// Stage E7.4b — OFFLINE / INJECTED-MOCK recording worker on a DISPOSABLE local PostgreSQL (0001–0014). Contract:
// claude/e74b-recording-worker-contract.md revision 2 + root implementation addendum A–E. Every Hostaway response here is a SYNTHETIC,
// DOC-DERIVED, LIVE-UNVERIFIED mock built in this file; nothing reaches a provider. 'credit_card' / 'other' / 'acct-test-1' / 'client-A'
// are FIXTURE values (no owner paymentMethod choice implied). USD only; legacy MXN fixtures authorize nothing. Fixture times / leases are
// adjusted only as labelled TEST SETUP in this disposable cluster; max_attempts and the shared read backoff are never changed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { runRecordingStep, RECORDING_LIMITS } from "../../lib/booking-db/recording-worker.js";
import { adminReleasePreflightHold, adminResolveOperation } from "../../db/lib/admin.js";
import { applyEvent } from "../../db/lib/repo.js";
import { recordReleaseReviewAssessment, completeOperation, completeRecordingWithEvidence, requestRead } from "../../db/lib/operations.js";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-A" });
const REF_FIELD = 777007;
const sleep = (t) => new Promise((r) => setTimeout(r, t));
let stayN = 0;
const stay = (o = {}) => { stayN += 1; const d = new Date(Date.UTC(2034, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2034, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 880000 + stayN, from: d, to: e, currency: "USD", ...o }; };
const cfgFor = (listingId, o = {}) => ({ accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId, paymentMethod: "credit_card", refFieldId: REF_FIELD, ...o });
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await db.owner.query(sql, p)).rows;
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const recording = (intentId) => one(`SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'
  ORDER BY split_part(idempotency_key, ':', 3)::int DESC LIMIT 1`, [intentId]);
const intentRow = (id) => one("SELECT state, version, offline_charge_id FROM booking.intents WHERE id = $1", [id]);
const holdOf = (opId) => one("SELECT * FROM booking.recording_holds WHERE operation_id = $1 AND released_at IS NULL", [opId]);
const assessments = (opId) => all("SELECT * FROM booking.recording_assessments WHERE operation_id = $1 ORDER BY seq", [opId]);
const notifies = (id) => num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);
const unknownCase = (id) => num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'OFFLINE_CHARGE_OUTCOME_UNKNOWN' AND status = 'open'", [id]);
const reads = (id, t) => all(`SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 AND created_at > now() - interval '1 hour' ORDER BY created_at`, [id, t]);
const ID_T = "hostaway.retrieve_reservation"; const LIST_T = "hostaway.list_offline_charges";
const requestReadRaw = (intentId, t, rid) => requestRead(db.app, intentId, t, rid, { now: Date.now() });

/** a USD captured booking on its own listing (payment_captured, pending initial recording) */
async function booking(o = {}) {
  const st = stay(o.stay);
  const c = await F.captured(db.app, st);
  const i = await one("SELECT ref, hostaway_reservation_id, final_total_minor FROM booking.intents WHERE id = $1", [c.id]);
  return { c, id: c.id, ref: i.ref, rid: i.hostaway_reservation_id, listingId: st.listingId, from: st.from, to: st.to, total: Number(i.final_total_minor),
    cfg: cfgFor(st.listingId, o.cfg) };
}
const TITLE = (b) => `maraVilla payment mvoch1-${b.id}`;
const charge = (b, o = {}) => ({ id: 700000 + Math.floor(Math.random() * 99999), listingMapId: b.listingId, reservationId: Number(b.rid), type: "charge",
  title: "Accommodation payment", currency: "USD", paymentMethod: "credit_card", amount: 10, status: "paid", paymentProvider: "offline", ...o });

/** SYNTHETIC Hostaway world for ONE reservation (DOC-DERIVED shapes; per-key override hooks) */
function world(b, o = {}) {
  const w = { charges: [...(o.charges || [])], calls: { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 }, nextId: 900000 + stayN * 100,
    identity: o.identity || null, list: o.list || null, create: o.create || null, paths: [] };
  w.resv = () => ({ id: Number(b.rid), listingMapId: b.listingId, channelId: 2000, arrivalDate: b.from, departureDate: b.to, totalPrice: b.total / 100,
    currency: "USD", status: "new", customFieldValues: [{ customFieldId: REF_FIELD, value: b.ref }] });
  w.listReply = () => ({ httpStatus: 200, json: { status: "success", result: w.charges.map((x) => ({ ...x })), count: w.charges.length, offset: null } });
  w.addCharge = (req, extra = {}) => { const ch = { id: w.nextId++, listingMapId: b.listingId, reservationId: Number(b.rid), type: "charge", title: req.body.title,
    currency: "USD", paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline", ...extra }; w.charges.push(ch); return ch; };
  w.executors = {
    label: LABEL,
    retrieveReservation: async (req) => { w.calls.retrieveReservation += 1; w.paths.push(req.path); return w.identity ? w.identity(req, w) : { httpStatus: 200, json: { status: "success", result: w.resv() } }; },
    listOfflineCharges: async (req) => { w.calls.listOfflineCharges += 1; w.paths.push(`${req.path}?${req.query.reservationId}`); return w.list ? w.list(req, w) : w.listReply(); },
    createOfflineCharge: async (req) => { w.calls.createOfflineCharge += 1; w.paths.push(req.path);
      if (w.create) return w.create(req, w);
      const ch = w.addCharge(req);
      return { httpStatus: 201, json: { status: "success", result: { ...ch } } }; }
  };
  return w;
}
const step = (b, w, o = {}) => runRecordingStep(o.pool || db.app, { workerId: o.workerId || "rw-1", env: ENV, listings: o.listings || new Map([[b.listingId, b.cfg]]),
  executors: w.executors, clock: o.clock || Date.now, intentId: o.scope === null ? undefined : (o.scope || b.id), ...(o.timeouts ? { timeouts: o.timeouts } : {}),
  ...(o.hooks ? { hooks: o.hooks } : {}), ...(o.monotonic ? { monotonic: o.monotonic } : {}) });
// TEST SETUP (disposable cluster): make the intent due and its work lease free; make pending reads due (never changes attempts / max_attempts)
const due = (b) => db.owner.query("UPDATE booking.intent_work SET next_action_at = now() - interval '1 second', work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [b.id]);
const readsDue = (b) => db.owner.query(`UPDATE booking.external_operations SET next_attempt_at = now() - interval '1 second'
  WHERE intent_id = $1 AND retry_class = 'read' AND state = 'pending'`, [b.id]);
const expireOp = (opId) => F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET lease_until = now() - interval '1 second' WHERE id = $1", [opId]);
async function steps(b, w, n, o = {}) { const out = []; for (let k = 0; k < n; k++) { await due(b); await readsDue(b); out.push(await step(b, w, o)); } return out; }

// ---------------------------------------------------------------------------------------------
test("W-1 happy path, BOTH approved fixture methods: eligible → claim → ONE write → confirming read → complete (D5) → confirmed; one guest.notify row, never executed", async () => {
  for (const method of ["credit_card", "other"]) {
    const b = await booking({ cfg: { paymentMethod: method } });
    const w = world(b);
    const r = await step(b, w);
    assert.equal(r.status, "worked", JSON.stringify(r.actions));
    assert.deepEqual(r.actions.filter((a) => /^(ASSESSED|CLAIMED|COMPLETED|RECORDED)/.test(a)), ["ASSESSED:eligible", "CLAIMED", "COMPLETED", "RECORDED->confirmed"], method);
    assert.deepEqual([w.calls.retrieveReservation, w.calls.listOfflineCharges, w.calls.createOfflineCharge, r.writes], [1, 2, 1, 1], method);
    const op = await recording(b.id);
    const ev = await one("SELECT * FROM booking.provider_evidence WHERE id = $1", [op.settled_evidence_id]);
    assert.deepEqual([op.state, op.attempts, ev.observed.paymentMethod, ev.observed.executorAccountRef, ev.observed.currency], ["succeeded", 1, method, "acct-test-1", "USD"]);
    const [au] = await all("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [op.id]);
    const [a] = await assessments(op.id);
    assert.deepEqual([au.assessment_id, a.outcome, a.cfg.paymentMethod, a.cfg.currency], [a.id, "eligible", method, "USD"]);
    assert.equal((await intentRow(b.id)).state, "confirmed");
    assert.equal(await notifies(b.id), 1, "exactly one queued guest.notify row");
    assert.equal(await num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify' AND state <> 'pending'", [b.id]), 0, "never executed");
    // further steps: nothing to do, no second write
    const later = await steps(b, w, 2);
    assert.ok(later.every((x) => x.writes === 0 && x.status === "idle"));
    assert.equal(w.calls.createOfflineCharge, 1);
  }
});

test("gate / dispatch-disabled: refused configurations touch NOTHING (no query, no read, no write)", async () => {
  const b = await booking();
  const w = world(b);
  const trap = { query: async () => { throw new Error("must not query"); }, connect: async () => { throw new Error("must not connect"); } };
  const run = (o) => runRecordingStep(trap, { workerId: "rw-1", env: ENV, listings: new Map([[b.listingId, b.cfg]]), executors: w.executors, clock: Date.now, intentId: b.id, ...o });
  const { paymentMethod, ...noMethod } = b.cfg;
  const cases = [
    [{ env: { VERCEL_ENV: "production", MV_E7_RECORDING_WORKER: "enabled" } }, "PRODUCTION_REFUSED"],
    [{ env: { VERCEL_ENV: "development" } }, "NOT_ENABLED"],
    [{ listings: new Map([[b.listingId, noMethod]]) }, "PAYMENT_METHOD_UNSET"],
    [{ listings: new Map([[b.listingId, { ...b.cfg, paymentMethod: "cash" }]]) }, "PAYMENT_METHOD_NOT_APPROVED"],
    [{ listings: new Map([[b.listingId, { ...b.cfg, currency: "MXN" }]]) }, "CURRENCY_NOT_APPROVED"],
    [{ executors: { ...w.executors, cancelReservation: async () => {} } }, "EXECUTOR_NOT_ALLOWED"],
    [{ executors: { ...w.executors, createOfflineCharge: undefined } }, "NO_EXECUTORS"],
    [{ executors: { ...w.executors, label: { accountRef: "acct-other", clientSnapshotId: "client-A" } } }, "LABEL_ACCOUNT_MISMATCH"],
    [{ workerId: "bad worker" }, "WORKER_ID_INVALID"],
  ];
  for (const [o, code] of cases) assert.deepEqual([(await run(o)).status, (await run(o)).code], ["refused", code], code);
  assert.deepEqual(w.calls, { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 });
  assert.equal((await recording(b.id)).state, "pending");
});

test("addendum A: PROTECTED reservations get ZERO action — explicit scope refused before maintenance; unscoped steps skip a protected due expired op and a protected missed outcome, and still serve an allowed intent", async () => {
  const P = PROTECTED();
  // protected 1: recording claimed (real assessment) then left in flight with an EXPIRED lease (due maintenance)
  const p1 = await booking({ stay: { reservationId: Number(P[0]) } });
  const op1 = await F.claimHealthyRecording(db.app, { workerId: "w-hist", now: Date.now(), intentId: p1.id, opTypes: ["hostaway.record_offline_charge"], leaseMs: 1 });
  assert.ok(op1);
  await sleep(5);
  // protected 2: a succeeded + LINKED recording whose E3 event was never applied (a missed outcome the recovery pass would finalise)
  const p2 = await booking({ stay: { reservationId: Number(P[1]) } });
  const { op: op2, t } = await F.claimRecording(db.app, { ...p2.c, listingId: p2.listingId }, Date.now(), "w-hist");
  const ev2 = await F.chargeListEvidence(db.app, { ...p2.c, listingId: p2.listingId }, F.recordingObserved({ ...p2.c, listingId: p2.listingId }, "990001",
    { currency: "USD", amountMinor: p2.total }), t + 5);
  F.ok(await completeRecordingWithEvidence(db.app, op2.id, { workerId: "w-hist", evidenceId: ev2, resultRef: "990001", expectedVersion: (await intentRow(p2.id)).version }));
  const allowed = await booking();
  const wA = world(allowed);
  const snap = async () => JSON.stringify(await all(`SELECT id, state, lease_until, attempts, settled_evidence_id FROM booking.external_operations WHERE intent_id = ANY($1) ORDER BY id`, [[p1.id, p2.id]]))
    + JSON.stringify(await all("SELECT id, state, version FROM booking.intents WHERE id = ANY($1) ORDER BY id", [[p1.id, p2.id]]))
    + await num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = ANY($1)", [[p1.id, p2.id]]);
  const before = await snap();
  const listings = new Map([[p1.listingId, p1.cfg], [p2.listingId, p2.cfg], [allowed.listingId, allowed.cfg]]);
  for (const x of [p1, p2]) {
    await db.owner.query("UPDATE booking.intent_work SET next_action_at = now() - interval '1 second', work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [x.id]);
    const r = await step(x, wA, { listings });
    assert.deepEqual([r.status, r.code], ["refused", "PROTECTED_RESERVATION_ID"], "explicit protected scope: read-only inspection, refused");
  }
  const r = await step(allowed, wA, { listings, scope: null });
  assert.equal(r.status, "worked");
  assert.equal(r.intentId, allowed.id, "the allowed intent is served");
  assert.equal(await snap(), before, "protected rows / intents / cases untouched (no maintenance, recovery, read, hold, case or event)");
  assert.ok(wA.paths.every((p) => !P.some((id) => p.includes(id))), "no provider call for a protected reservation");
  assert.equal((await intentRow(allowed.id)).state, "confirmed");
});
const PROTECTED = () => ["70636076", "71045356", "71072615", "71081885"];

test("no action / fail closed: wrong listing (out of scope), attempt > 1 → ATTEMPT_GT1 hold, succeeded-unproven → SUCCEEDED_UNPROVEN hold, active hold, outcome_unknown", async () => {
  // out of scope: the listing is not configured
  { const b = await booking(); const other = await booking(); const w = world(b);
    const r = await step(b, w, { listings: new Map([[other.listingId, other.cfg]]) });
    assert.equal(r.status, "idle"); assert.equal(w.calls.retrieveReservation + w.calls.listOfflineCharges + w.calls.createOfflineCharge, 0); }
  // attempt 2 pending (genuine E3 path)
  { const b = await booking(); const w = world(b);
    const a1 = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: b.id, opTypes: ["hostaway.record_offline_charge"] });
    F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
    const api = await F.readEvidence(db.app, b.id, "hostaway_offline_charges", b.rid, "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 40);
    const dsh = await F.dashboardEvidence(db.reconciler, b.id, "hostaway_offline_charges", b.rid, "listed", { matchingChargeCount: 0, matchingChargeIds: [] }, 45);
    F.ok(await adminResolveOperation(db.reconciler, { operationId: a1.id, decision: "failed_definite", evidenceIds: [api, dsh], resolver: "owner", justification: "NO_CHARGE_IN_HOSTAWAY", at: F.at(60) }));
    F.ok(await applyEvent(db.app, b.id, { type: "OFFLINE_CHARGE_FAILED" }, { now: F.at(61) }));
    await due(b);
    const r = await step(b, w);
    assert.ok(r.actions.includes("HOLD:ATTEMPT_GT1"), JSON.stringify(r.actions));
    assert.equal((await holdOf((await recording(b.id)).id)).reason, "ATTEMPT_GT1");
    await due(b);
    assert.ok((await step(b, w)).actions.includes("STOP:HOLD_ACTIVE"));
    assert.equal(w.calls.retrieveReservation + w.calls.listOfflineCharges + w.calls.createOfflineCharge, 0); }
  // succeeded, unproven (owner-resolved from count-only evidence)
  { const b = await booking(); const w = world(b);
    const a1 = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: b.id, opTypes: ["hostaway.record_offline_charge"] });
    F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
    const ev0 = await F.readEvidence(db.app, b.id, "hostaway_offline_charges", b.rid, "listed", { matchingChargeCount: 1, matchingChargeIds: ["991001"] }, 30);
    F.ok(await adminResolveOperation(db.reconciler, { operationId: a1.id, decision: "succeeded", evidenceIds: [ev0], resultRef: 991001, resolver: "owner", justification: "CHARGE_FOUND_IN_HOSTAWAY", at: F.at(60) }));
    await due(b);
    const r = await step(b, w);
    assert.ok(r.actions.includes("HOLD:SUCCEEDED_UNPROVEN"), JSON.stringify(r.actions));
    assert.equal(w.calls.createOfflineCharge + w.calls.listOfflineCharges, 0);
    assert.equal((await intentRow(b.id)).state, "payment_captured", "never finalised without a link"); }
  // outcome_unknown recording: stop
  { const b = await booking(); const w = world(b);
    const a1 = await F.claimHealthyRecording(db.app, { workerId: "w1", now: F.at(9), intentId: b.id, opTypes: ["hostaway.record_offline_charge"] });
    F.ok(await completeOperation(db.app, a1.id, { workerId: "w1", now: F.at(9.2), outcome: { status: "outcome_unknown" } }));
    await due(b);
    const r = await step(b, w);
    assert.ok(r.actions.includes("STOP:RECORDING_OUTCOME_UNKNOWN"), JSON.stringify(r.actions));
    assert.equal(w.calls.retrieveReservation + w.calls.createOfflineCharge, 0); }
});

test("conflicts latch and open the DB-derived preflight hold; 0 writes (marker / look-alike / same amount)", async () => {
  const kinds = [["conflict_marker", "PREFLIGHT_CONFLICT_MARKER", (b) => charge(b, { title: TITLE(b), amount: b.total / 100 })],
    ["conflict_lookalike", "PREFLIGHT_CONFLICT_LOOKALIKE", (b) => charge(b, { title: `refund ${TITLE(b)}` })],
    ["conflict_same_amount", "PREFLIGHT_CONFLICT_SAME_AMOUNT", (b) => charge(b, { amount: b.total / 100 })]];
  for (const [outcome, reason, mk] of kinds) {
    const b = await booking();
    const w = world(b, { charges: [mk(b)] });
    const r = await step(b, w);
    assert.ok(r.actions.includes(`ASSESSED:${outcome}:${{ conflict_marker: "PRIOR_RECORDING_MARKER_PRESENT", conflict_lookalike: "MARKER_LOOKALIKE_CONFLICT", conflict_same_amount: "SAME_AMOUNT_PAID_UNMARKED_CONFLICT" }[outcome]}`), JSON.stringify(r.actions));
    assert.equal((await holdOf((await recording(b.id)).id)).reason, reason);
    assert.equal(w.calls.createOfflineCharge, 0);
    const later = await steps(b, w, 2);
    assert.ok(later.every((x) => x.actions.includes("STOP:HOLD_ACTIVE")));
    assert.equal(w.calls.createOfflineCharge, 0);
  }
});

test("counted refusals: three IDENTITY_HTTP_STATUS responses (distinct reads) → EXHAUSTED preflight hold; 0 writes; no evidence fabricated for a refused identity", async () => {
  const b = await booking();
  const w = world(b, { identity: () => ({ httpStatus: 404, json: { status: "fail", result: "not found" } }) });
  const out = await steps(b, w, 3);
  assert.deepEqual(out.map((x) => x.actions.find((a) => a.startsWith("ASSESSED"))), Array(3).fill("ASSESSED:identity_refused:IDENTITY_HTTP_STATUS"));
  const op = await recording(b.id);
  assert.equal((await holdOf(op.id)).reason, "PREFLIGHT_EXHAUSTED");
  const rs = await reads(b.id, ID_T);
  assert.deepEqual(rs.map((x) => [x.state, x.error_code]), Array(3).fill(["succeeded", "IDENTITY_HTTP_STATUS"]), "raw diagnostic on the read row");
  assert.equal(await num("SELECT count(*) AS n FROM booking.provider_evidence WHERE read_operation_id = ANY($1)", [rs.map((x) => x.id)]), 0);
  assert.deepEqual([w.calls.retrieveReservation, w.calls.listOfflineCharges, w.calls.createOfflineCharge], [3, 0, 0]);
});

test("R2 §4.4: 30 identity TIMEOUTS → exactly 3 read rows, 30 executions, 3 counted READ_NOT_COMPLETED, retries-exhausted case from the 10th, PREFLIGHT_EXHAUSTED hold; never a random new row", async () => {
  const b = await booking();
  const w = world(b, { identity: () => new Promise(() => {}) });          // never settles: bounded by readCallMs
  const out = await steps(b, w, 30, { timeouts: { readCallMs: 5 } });
  const op = await recording(b.id);
  const rs = await reads(b.id, ID_T);
  assert.equal(rs.length, 3, "exactly three identity rows");
  assert.deepEqual(rs.map((x) => [x.state, x.attempts, x.max_attempts]), Array(3).fill(["escalated", 10, 10]));
  assert.equal(w.calls.retrieveReservation, 30, "30 real retry executions");
  assert.ok(out[9].actions.some((a) => a === "READ:ID:TRANSPORT_TIMEOUT:escalated"));
  assert.deepEqual((await assessments(op.id)).map((a) => [a.outcome, a.code, a.identity_read_op]), rs.map((x) => ["identity_refused", "READ_NOT_COMPLETED", x.id]));
  assert.equal(await num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'OPERATION_RETRIES_EXHAUSTED'", [b.id]), 1);
  assert.equal((await holdOf(op.id)).reason, "PREFLIGHT_EXHAUSTED");
  assert.deepEqual([w.calls.listOfflineCharges, w.calls.createOfflineCharge], [0, 0]);
  // steps 1..9 of each row re-use the SAME row (no random new row)
  for (const k of [1, 5, 8]) assert.ok(out[k].actions.some((a) => a === "READ:ID:TRANSPORT_TIMEOUT:pending"));
  const after = await steps(b, w, 2, { timeouts: { readCallMs: 5 } });
  assert.ok(after.every((x) => x.actions.includes("STOP:HOLD_ACTIVE")) && w.calls.retrieveReservation === 30);
});

test("R2 §4.3 list-first: 30 list TIMEOUTS with a healthy identity → 3 list rows, 4 identity reads, 3 counted incomplete READ_NOT_COMPLETED, hold; budget never hit", async () => {
  const b = await booking();
  const w = world(b, { list: () => new Promise(() => {}) });
  await steps(b, w, 30, { timeouts: { readCallMs: 5 } });
  const op = await recording(b.id);
  const ls = await reads(b.id, LIST_T); const is = await reads(b.id, ID_T);
  assert.equal(ls.length, 3);
  assert.deepEqual(ls.map((x) => [x.state, x.attempts]), Array(3).fill(["escalated", 10]));
  assert.equal(w.calls.listOfflineCharges, 30);
  assert.equal(is.length, 4, "identity read only once the list escalated (plus the very first step)");
  const as = await assessments(op.id);
  assert.deepEqual(as.map((a) => [a.outcome, a.code]), Array(3).fill(["incomplete", "READ_NOT_COMPLETED"]));
  assert.deepEqual(as.map((a) => a.list_read_op), ls.map((x) => x.id));
  assert.equal((await holdOf(op.id)).reason, "PREFLIGHT_EXHAUSTED");
  assert.equal(w.calls.createOfflineCharge, 0);
});

test("R2-B budget: six read rows above the floor burnt by crashes after evidence → the 7th need escalates RECORDING_PREFLIGHT_READ_BUDGET_EXHAUSTED (fenced, scoped); 0 writes", async () => {
  const b = await booking();
  const w = world(b);
  const boom = new Error("crash after identity evidence (TEST)");
  for (let k = 0; k < 6; k++) {
    await due(b);
    await assert.rejects(step(b, w, { hooks: { afterEvidence: async (t) => { if (t === ID_T) throw boom; } } }), (e) => e === boom);
  }
  assert.equal((await reads(b.id, ID_T)).length, 6);
  await due(b);
  const r = await step(b, w);
  assert.ok(r.actions.includes("ESCALATE:RECORDING_PREFLIGHT_READ_BUDGET_EXHAUSTED"), JSON.stringify(r.actions));
  assert.equal((await reads(b.id, ID_T)).length, 6, "no 7th row");
  assert.notEqual((await intentRow(b.id)).state, "payment_captured");
  assert.equal(w.calls.createOfflineCharge, 0);
});

/** TEST SETUP: release the active preflight hold with a real eligible review (owner path; never the worker) */
async function ownerRelease(b) {
  const op = await recording(b.id);
  const h = await holdOf(op.id);
  await db.owner.query("UPDATE booking.intent_work SET work_worker_id = 'w-review', work_lease_until = now() + interval '10 minutes' WHERE intent_id = $1", [b.id]);
  const f = await F.preflightFacts(db.app, b.id);
  const t = Date.now();
  const idRead = await F.completedRead(db.app, b.id, ID_T, f.hostaway_reservation_id, t);
  const idEv = await F.readEvidenceOf(db.app, idRead, "hostaway_reservation", f.hostaway_reservation_id, "found_active", F.identityObserved(f));
  const listRead = await F.completedRead(db.app, b.id, LIST_T, f.hostaway_reservation_id, t);
  const listEv = await F.readEvidenceOf(db.app, listRead, "hostaway_offline_charges", f.hostaway_reservation_id, "listed", F.preflightListObserved());
  const rv = F.ok(await recordReleaseReviewAssessment(db.app, h.id, { workerId: "w-review", outcome: "eligible", identityReadId: idRead, listReadId: listRead,
    identityEvidenceId: idEv, listEvidenceId: listEv, expectedVersion: f.version, moduleVersion: F.PROOF_MODULE_VERSION, clientLabel: F.PREFLIGHT_CLIENT_LABEL,
    accountRef: F.PREFLIGHT_ACCOUNT_REF, config: F.preflightConfig(f) }));
  F.ok(await adminReleasePreflightHold(db.reconciler, { holdId: h.id, reviewId: rv.id, resolver: "owner", justification: "PREFLIGHT_RECHECKED_CLEAN", at: Date.now() }));
  await sleep(3);
}

test("epoch 2: two owner releases (conflict each epoch) → the worker's fresh epoch-2 assessment qualifies the claim; audit binds epoch 2; old-epoch rows ignored", async () => {
  const b = await booking();
  const marker = charge(b, { title: TITLE(b), amount: b.total / 100 });
  const w = world(b, { charges: [marker] });
  await steps(b, w, 1);
  await ownerRelease(b);
  await steps(b, w, 1);                                                   // epoch 1: conflict again
  assert.equal((await holdOf((await recording(b.id)).id)).epoch, 1);
  // TEST SETUP: an OPEN identity read requested BEFORE the release that opens epoch 2 (below the floor F: never reused or cited)
  const stale = await requestReadRaw(b.id, ID_T, b.rid);
  await ownerRelease(b);
  w.charges = [];                                                         // TEST SETUP: the marker charge is gone
  const [r] = await steps(b, w, 1);
  assert.ok(r.actions.includes("RECORDED->confirmed"), JSON.stringify(r.actions));
  const op = await recording(b.id);
  const au = await one("SELECT * FROM booking.recording_claim_assessments WHERE operation_id = $1", [op.id]);
  const a = await one("SELECT * FROM booking.recording_assessments WHERE id = $1", [au.assessment_id]);
  assert.deepEqual([au.epoch, a.epoch, a.outcome, a.worker], [2, 2, "eligible", "rw-1"]);
  assert.notEqual(a.identity_read_op, stale);
  assert.deepEqual([(await one("SELECT state, attempts FROM booking.external_operations WHERE id = $1", [stale])).state, (await one("SELECT attempts FROM booking.external_operations WHERE id = $1", [stale])).attempts], ["pending", 0], "the pre-release open row was never executed");
  assert.equal(w.calls.createOfflineCharge, 1);
});

test("D5 at completion: the claim snapshot's method changed after the final check (TEST SETUP, triggers bypassed) → RECORDING_CLAIM_BINDING → ONE unknown settlement; 1 write, never a second", async () => {
  const b = await booking();
  const w = world(b);
  const r = await step(b, w, { hooks: { afterWrite: async (op) => {
    await F.ownerManagedHistory(db.owner, `UPDATE booking.recording_assessments SET cfg = jsonb_set(cfg, '{paymentMethod}', '"other"')
      WHERE id = (SELECT assessment_id FROM booking.recording_claim_assessments WHERE operation_id = $1)`, [op.id]); } } });
  assert.ok(r.actions.includes("COMPLETE!RECORDING_CLAIM_BINDING") && r.actions.includes("UNKNOWN:COMPLETE_RECORDING_CLAIM_BINDING"), JSON.stringify(r.actions));
  const op = await recording(b.id);
  assert.deepEqual([op.state, op.settled_evidence_id, await unknownCase(b.id)], ["outcome_unknown", null, 1]);
  await steps(b, w, 3);
  assert.equal(w.calls.createOfflineCharge, 1);
});

test("§6.1 post-claim aborts (op lease, work lease, hold, budget, same-worker newer assessment) → ONE unknown settlement + case; 0 writes; none later", async () => {
  const cases = [
    ["OPERATION_LEASE_TOO_SHORT", { beforeFinalCheck: async (op) => { await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET lease_until = now() + interval '20 seconds' WHERE id = $1", [op.id]); } }],
    ["WORK_LEASE", { beforeFinalCheck: async (op) => { await db.owner.query("UPDATE booking.intent_work SET work_lease_until = now() + interval '5 seconds' WHERE intent_id = $1", [op.intent_id]); } }],
    ["HOLD_ACTIVE", { beforeFinalCheck: async (op) => { await F.ownerManagedHistory(db.owner, `WITH k AS (INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
        VALUES (gen_random_uuid(), $2, 'OFFLINE_CHARGE_HOLD_SUCCEEDED_UNPROVEN', 'open', now(), 'probe', '{}') RETURNING id)
      INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by)
        SELECT gen_random_uuid(), $1, $2, 'SUCCEEDED_UNPROVEN', k.id, 'in_flight', 'k', 'payment_captured', 1, now(), 'probe' FROM k`, [op.id, op.intent_id]); } }],
    ["CLAIM_ASSESSMENT_BINDING", { afterAssessment: async (id, outcome) => {
      if (outcome !== "eligible") return;
      const row = await one("SELECT operation_id, intent_id FROM booking.recording_assessments WHERE id = $1", [id]);
      F.ok((await F.preflight(db.app, row.intent_id, row.operation_id, { workerId: "rw-1", t: Date.now() })).r, "newer eligible assessment by the SAME worker id"); } }],
  ];
  for (const [code, hooks] of cases) {
    const b = await booking();
    const w = world(b);
    const r = await step(b, w, { hooks });
    assert.ok(r.actions.includes(`SEND_ABORTED:${code}`) && r.actions.includes(`UNKNOWN:SEND_ABORTED_${code}`), `${code}: ${JSON.stringify(r.actions)}`);
    assert.deepEqual([r.writes, w.calls.createOfflineCharge, (await recording(b.id)).state, await unknownCase(b.id)], [0, 0, "outcome_unknown", 1], code);
    await steps(b, w, 2);
    assert.equal(w.calls.createOfflineCharge, 0, code);
  }
  // step budget (controlled monotonic clock)
  const b = await booking(); const w = world(b);
  let m = 0; const mono = () => m;
  const r = await step(b, w, { monotonic: mono, hooks: { beforeFinalCheck: async () => { m = 50000; } } });
  assert.ok(r.actions.includes("UNKNOWN:SEND_ABORTED_STEP_BUDGET"), JSON.stringify(r.actions));
  assert.equal(w.calls.createOfflineCharge, 0);
});

test("§6.2 post-write branches: timeout, throw, non-2xx, zero / multiple / mismatching confirmation, future and stale confirmation → ONE unknown settlement; 1 write; never a second", async () => {
  let off = 0; const clock = () => Date.now() + off;
  const cases = [
    ["WRITE_TIMEOUT", { create: () => new Promise(() => {}) }, { timeouts: { writeCallMs: 10, lateWindowMs: 20 } }],
    ["WRITE_CALL_FAILED", { create: async () => { throw new Error("socket hang up (mock)"); } }],
    ["REPLY_REPLY_HTTP_STATUS", { create: async () => ({ httpStatus: 500, json: { status: "fail", result: "boom" } }) }],
    ["CONFIRM_ZERO_MATCH", { create: async (req, w) => { const c = w.addCharge(req); w.charges.pop(); return { httpStatus: 201, json: { status: "success", result: { ...c } } }; } }],
    ["CONFIRM_MULTIPLE_MATCHES", { create: async (req, w) => { const c = w.addCharge(req); w.addCharge(req); return { httpStatus: 201, json: { status: "success", result: { ...c } } }; } }],
    ["CONFIRM_ID_MISMATCH", { create: async (req, w) => { const c = w.addCharge(req); return { httpStatus: 201, json: { status: "success", result: { ...c, id: c.id + 77 } } }; } }],
    ["COMPLETE_RECORDING_PROOF_REFUSED", {}, { hooks: { afterWrite: async () => { off = 5000; } } }],
    ["CONFIRM_DISPATCH_TIME_INVALID", {}, { hooks: { afterWrite: async () => { off = -180000; } } }],   // a backwards / stale confirming clock (pure refuses before NOT_AFTER_DISPATCH)
  ];
  for (const [code, wo, so = {}] of cases) {
    off = 0;
    const b = await booking();
    const w = world(b, wo);
    const r = await step(b, w, { clock, ...so });
    off = 0;
    assert.ok(r.actions.includes(`UNKNOWN:${code}`), `${code}: ${JSON.stringify(r.actions)}`);
    assert.deepEqual([r.writes, w.calls.createOfflineCharge, (await recording(b.id)).state, await unknownCase(b.id)], [1, 1, "outcome_unknown", 1], code);
    assert.equal((await recording(b.id)).settled_evidence_id, null);
    await steps(b, w, 3);
    assert.equal(w.calls.createOfflineCharge, 1, `${code}: no second write`);
    assert.equal((await intentRow(b.id)).state, "payment_captured");
  }
});

test("R4 / addendum D: a late reply is observed in memory only, within a finite window, even if it never settles; no DB change, no event", async () => {
  // never settles
  { const b = await booking(); const w = world(b, { create: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await step(b, w, { timeouts: { writeCallMs: 10, lateWindowMs: 40 } });
    assert.ok(Date.now() - t0 < 5000, "the step returns without waiting for the late window");
    assert.deepEqual(await r.late, { kind: "none" });
    assert.equal((await recording(b.id)).state, "outcome_unknown"); }
  // settles late (fulfilled / rejected): bounded status only; the unknown row is untouched
  for (const mode of ["fulfilled", "rejected"]) {
    const b = await booking();
    const w = world(b, { create: () => new Promise((res, rej) => setTimeout(() => (mode === "fulfilled" ? res({ httpStatus: 201, json: { status: "success", result: {} } }) : rej(new Error("late reject"))), 30)) });
    const r = await step(b, w, { timeouts: { writeCallMs: 10, lateWindowMs: 500 } });
    const before = JSON.stringify(await recording(b.id));
    assert.deepEqual(await r.late, mode === "fulfilled" ? { kind: "late_reply", settled: "fulfilled", httpStatus: 201 } : { kind: "late_reply", settled: "rejected", httpStatus: null });
    await sleep(20);
    assert.equal(JSON.stringify(await recording(b.id)), before, "no late DB mutation");
    assert.equal((await recording(b.id)).late_result_status, null);
  }
});

test("lease loss after the write: op lease expired → RECORDING_LEASE_LOST, no settlement by the worker, maintenance marks unknown later; work lease lost likewise; never a resend", async () => {
  for (const [code, hook] of [["RECORDING_LEASE_LOST", async (op) => expireOp(op.id)],
    ["RECORDING_WORK_LEASE_LOST", async (op) => db.owner.query("UPDATE booking.intent_work SET work_lease_until = now() - interval '1 second' WHERE intent_id = $1", [op.intent_id])]]) {
    const b = await booking(); const w = world(b);
    const r = await step(b, w, { hooks: { afterConfirmEvidence: hook } });
    assert.ok(r.actions.includes(`COMPLETE!${code}`) && !r.actions.some((a) => a.startsWith("UNKNOWN")), JSON.stringify(r.actions));
    if (code === "RECORDING_WORK_LEASE_LOST") await expireOp((await recording(b.id)).id);
    const [n] = await steps(b, w, 1);
    assert.ok(n.actions.includes("MAINTENANCE:hostaway.record_offline_charge:outcome_unknown"), JSON.stringify(n.actions));
    assert.equal((await recording(b.id)).error_code, "LEASE_EXPIRED");
    await steps(b, w, 2);
    assert.equal(w.calls.createOfflineCharge, 1);
  }
});

test("races: competing workers (one claims the work, one idles); the same-worker race is §6.1 CLAIM_ASSESSMENT_BINDING", async () => {
  const b = await booking(); const w = world(b);
  const [r1, r2] = await Promise.all([step(b, w, { workerId: "rw-A" }), step(b, w, { workerId: "rw-B" })]);
  assert.deepEqual([r1.status, r2.status].sort(), ["idle", "worked"]);
  assert.equal(w.calls.createOfflineCharge, 1);
  assert.equal((await intentRow(b.id)).state, "confirmed");
});

test("crash / recovery: a hook fault AFTER completion leaves success + link intact; the original error propagates, work not released; the next step (or another worker's recovery pass) finalises once; no resend, one outbox row", async () => {
  const b = await booking(); const w = world(b);
  const boom = new Error("hook fault after completion (TEST)");
  await assert.rejects(step(b, w, { hooks: { afterComplete: async () => { throw boom; } } }), (e) => e === boom);
  const op = await recording(b.id);
  assert.deepEqual([op.state, !!op.settled_evidence_id, (await intentRow(b.id)).state], ["succeeded", true, "payment_captured"]);
  assert.equal((await one("SELECT work_worker_id FROM booking.intent_work WHERE intent_id = $1", [b.id])).work_worker_id, "rw-1", "no work release after a thrown fault");
  // another worker's unscoped recovery pass applies OFFLINE_CHARGE_RECORDED (fenced, deduped)
  const r = await step(b, w, { workerId: "rw-2", scope: null });
  assert.ok(r.actions.includes("RECORDED->confirmed"), JSON.stringify(r.actions));
  assert.deepEqual([w.calls.createOfflineCharge, await notifies(b.id)], [1, 1]);
  // a claim followed by a crash before the write: lease expiry → unknown + case, 0 writes
  const b2 = await booking(); const w2 = world(b2);
  const boom2 = new Error("crash after claim (TEST)");
  await assert.rejects(step(b2, w2, { hooks: { afterClaim: async () => { throw boom2; } } }), (e) => e === boom2);
  assert.equal((await recording(b2.id)).state, "in_flight");
  await due(b2);
  assert.ok((await step(b2, w2)).actions.includes("STOP:RECORDING_IN_FLIGHT"));
  await expireOp((await recording(b2.id)).id);
  await steps(b2, w2, 2);
  assert.deepEqual([(await recording(b2.id)).state, await unknownCase(b2.id), w2.calls.createOfflineCharge], ["outcome_unknown", 1, 0]);
});

// ---------------------------------------------------------------------------------------------
// §6.3 / addendum E: outer DB failure matrix through a fault-injecting pool. 'before' = the statement / COMMIT never reached the
// database (acknowledged rollback); 'after' = it committed and the reply was lost. In both the step re-throws THE SAME error object and
// issues no further statement (only the helper's own ROLLBACK), not even the work release.
function faultPool(base, { match, mode }) {
  const log = []; const fault = Object.assign(new Error("connection terminated unexpectedly (TEST)"), { code: "57P01" }); const st = { fired: false };
  const note = (text) => { if (st.fired && !/^ROLLBACK/i.test(text)) log.push(text); };
  const run = async (q, text, values, inTx) => {
    note(text);
    if (!st.fired && match(text, values, inTx)) {
      st.fired = true;
      if (mode === "before") throw fault;
      await q(text, values); throw fault;
    }
    return q(text, values);
  };
  const pool = {
    totalCount: 0,
    query: (text, values) => run((t, v) => base.query(t, v), text, values, null),
    connect: async () => {
      const c = await base.connect(); const tx = { texts: [] };
      return { query: async (text, values) => {
        tx.texts.push(text);
        if (/^COMMIT/i.test(text)) return run((t, v) => c.query(t, v), text, values, tx);
        note(text); return c.query(text, values);
      }, release: () => c.release() };
    }
  };
  return { pool, fault, log, st };
}
const inTxWith = (re) => (text, _v, tx) => tx && /^COMMIT/i.test(text) && tx.texts.some((t) => re.test(t));
test("§6.3 ambiguous COMMIT matrix: claim / assessment / evidence / completion / event / unknown settlement × {rolled back, committed-reply-lost}: same error re-thrown, no further query, both persisted outcomes recovered on fresh facts; ≤ 1 write; ≤ 1 outbox row", async () => {
  const stages = [
    // the RECORDING claim transaction is the only claim that share-locks intent_work (ops:84–86)
    ["claim", (t, v, tx) => inTxWith(/SET state = 'in_flight'/)(t, v, tx) && tx.texts.some((x) => /FROM booking\.intent_work WHERE intent_id = \$1 FOR SHARE/.test(x))],
    ["assessment", (t, v) => /record_recording_assessment/.test(t) && v && v[2] === "eligible"],
    ["evidence", (t, v) => /record_provider_evidence/.test(t) && v && v[1] === "hostaway_offline_charges" && v[4] && Object.prototype.hasOwnProperty.call(v[4], "marker")],
    ["completion", (t) => /complete_recording_with_evidence/.test(t)],
    ["event", inTxWith(/INSERT INTO booking\.intent_applied_events/)],
    ["settlement", inTxWith(/SET state = 'outcome_unknown'/), { writeFails: true }],
  ];
  for (const [name, match, opt = {}] of stages) {
    for (const mode of ["before", "after"]) {
      const b = await booking(); const w = world(b);
      if (opt.writeFails) w.create = async () => ({ httpStatus: 500, json: { status: "fail", result: "x" } });
      const fp = faultPool(db.app, { match, mode });
      await assert.rejects(step(b, w, { pool: fp.pool }), (e) => e === fp.fault && e.code === "57P01" && /connection terminated/.test(e.message), `${name}/${mode}`);
      assert.ok(fp.st.fired, `${name}/${mode}: fault fired`);
      assert.deepEqual(fp.log, [], `${name}/${mode}: no statement after the fault (incl. no work release)`);
      const wl = await one("SELECT work_worker_id FROM booking.intent_work WHERE intent_id = $1", [b.id]);
      assert.equal(wl.work_worker_id, "rw-1", `${name}/${mode}: work lease not released`);
      const op0 = await recording(b.id);
      // persisted outcome right after the fault
      const expect0 = {
        claim: { before: "pending", after: "in_flight" }, assessment: { before: "pending", after: "pending" }, evidence: { before: "in_flight", after: "in_flight" },
        completion: { before: "in_flight", after: "succeeded" }, event: { before: "succeeded", after: "succeeded" }, settlement: { before: "in_flight", after: "outcome_unknown" }
      }[name][mode];
      assert.equal(op0.state, expect0, `${name}/${mode}: persisted state`);
      if (name === "event") assert.equal((await intentRow(b.id)).state, mode === "after" ? "confirmed" : "payment_captured");
      if (name === "assessment") assert.equal((await assessments(op0.id)).length, mode === "after" ? 1 : 0);
      // recovery on fresh persisted facts (TEST SETUP: free the work lease, expire an in-flight op lease)
      for (let k = 0; k < 3; k++) {
        await due(b); await readsDue(b);
        const op = await recording(b.id);
        if (op.state === "in_flight") await expireOp(op.id);
        await step(b, w);
      }
      const opN = await recording(b.id);
      const final = { claim: { before: "succeeded", after: "outcome_unknown" }, assessment: { before: "succeeded", after: "succeeded" },
        evidence: { before: "outcome_unknown", after: "outcome_unknown" }, completion: { before: "outcome_unknown", after: "succeeded" },
        event: { before: "succeeded", after: "succeeded" }, settlement: { before: "outcome_unknown", after: "outcome_unknown" } }[name][mode];
      assert.equal(opN.state, final, `${name}/${mode}: recovered state`);
      const writes = { claim: { before: 1, after: 0 } }[name]?.[mode] ?? 1;
      assert.equal(w.calls.createOfflineCharge, writes, `${name}/${mode}: writer invocations`);
      assert.ok(await notifies(b.id) <= 1, `${name}/${mode}: at most one outbox row`);
      if (final === "succeeded") assert.deepEqual([(await intentRow(b.id)).state, await notifies(b.id)], ["confirmed", 1], `${name}/${mode}: finalised once`);
    }
  }
});

test("§6.1 remaining S9 reasons (TEST SETUP between the claim and the final check): identity changed, op not held, assessment binding, stale preflight, intent changed → ONE unknown settlement (or an acknowledged refusal when the row is not ours), 0 writes", async () => {
  let off = 0; const clock = () => Date.now() + off;
  const replica = (sql, p) => F.ownerManagedHistory(db.owner, sql, p);
  const cases = [
    ["RECORDING_IDENTITY_CHANGED", async (op) => replica("UPDATE booking.external_operations SET payload = payload || '{\"extra\": 1}'::jsonb WHERE id = $1", [op.id])],
    ["OPERATION_NOT_HELD", async (op) => replica("UPDATE booking.external_operations SET lease_worker_id = 'rw-other' WHERE id = $1", [op.id]), "noSettle"],
    ["ASSESSMENT_BINDING", async (op) => replica(`UPDATE booking.recording_assessments SET cfg = jsonb_set(cfg, '{refFieldId}', '1')
        WHERE id = (SELECT assessment_id FROM booking.recording_claim_assessments WHERE operation_id = $1)`, [op.id])],
    ["PREFLIGHT_STALE", async (op) => { await replica("UPDATE booking.external_operations SET lease_until = now() + interval '20 minutes' WHERE id = $1", [op.id]);
      await db.owner.query("UPDATE booking.intent_work SET work_lease_until = now() + interval '20 minutes' WHERE intent_id = $1", [op.intent_id]); off = 125000; }],
    ["INTENT_CHANGED", async (op) => replica(`INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at)
        VALUES ($1, 9999, 'capture_unknown', 'payment_captured', 'PROBE', 'system', now())`, [op.intent_id])],
    // NOT_LATEST cannot be staged: the 0001 unique index external_operations_one_open_offline_charge forbids a second open recording (defence in depth)
  ];
  for (const [code, hook, noSettle] of cases) {
    off = 0;
    const b = await booking(); const w = world(b);
    const r = await step(b, w, { clock, hooks: { beforeFinalCheck: hook } });
    off = 0;
    assert.ok(r.actions.includes(`SEND_ABORTED:${code}`), `${code}: ${JSON.stringify(r.actions)}`);
    assert.equal(w.calls.createOfflineCharge, 0, code);
    if (noSettle) assert.ok(r.actions.includes(`UNKNOWN!LEASE_LOST`), `${code}: the row is not ours, so the settlement is refused (acknowledged), never forced`);
    else assert.deepEqual([(await recording(b.id)).state, await unknownCase(b.id)], ["outcome_unknown", 1], code);
  }
});

test("W-6: an allowlisted PERMANENT DB fact (ambiguous payment-captured entry) → fenced ESCALATE before any read; a non-allowlisted refusal is a local stop", async () => {
  const b = await booking(); const w = world(b);
  await F.ownerManagedHistory(db.owner, `INSERT INTO booking.intent_transitions (intent_id, version_after, from_state, to_state, event_type, actor, at)
    VALUES ($1, 9998, 'capture_unknown', 'payment_captured', 'PROBE', 'system', now())`, [b.id]);
  const r = await step(b, w);
  assert.ok(r.actions.includes("ESCALATE:RECORDING_RECORDED_PAYMENT_TIME_AMBIGUOUS"), JSON.stringify(r.actions));
  assert.equal(w.calls.retrieveReservation + w.calls.createOfflineCharge, 0);
  assert.notEqual((await intentRow(b.id)).state, "payment_captured");
  // a configured listing whose intent currency differs is CURRENCY_MISMATCH (allowlisted); a refFieldId-only config difference is NOT a fact → normal flow
  const m = await booking({ stay: { currency: "MXN" } });
  const wm = world(m);
  const rm = await step(m, wm);
  assert.ok(rm.actions.includes("ESCALATE:RECORDING_CURRENCY_MISMATCH"), JSON.stringify(rm.actions));
  assert.equal(wm.calls.retrieveReservation, 0);
});

test("R2 selection: an escalated read left by an EARLIER step is cited once while DB-fresh (no execution); a stale one is never cited; two open candidates stop with no read", async () => {
  const setupEscalated = async (b, minutesAgo) => {
    const id = await requestReadRaw(b.id, ID_T, b.rid);
    await F.ownerManagedHistory(db.owner, `UPDATE booking.external_operations SET state = 'escalated', attempts = 10, error_code = 'READ_TRANSPORT_TIMEOUT',
      updated_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutesAgo]);
    return id;
  };
  // fresh escalated (crash between escalation and citation): cited, the identity executor is NOT called
  { const b = await booking(); const w = world(b); await sleep(3);
    const esc = await setupEscalated(b, 0);
    const r = await step(b, w);
    assert.ok(r.actions.includes("ASSESSED:identity_refused:READ_NOT_COMPLETED"), JSON.stringify(r.actions));
    assert.equal((await assessments((await recording(b.id)).id))[0].identity_read_op, esc);
    assert.equal(w.calls.retrieveReservation, 0); }
  // stale escalated (3 min): not cited; a new row is executed and the normal flow completes
  { const b = await booking(); const w = world(b); await sleep(3);
    const esc = await setupEscalated(b, 3);
    const r = await step(b, w);
    assert.ok(r.actions.includes("RECORDED->confirmed"), JSON.stringify(r.actions));
    assert.equal(await num("SELECT count(*) AS n FROM booking.recording_assessments WHERE identity_read_op = $1", [esc]), 0);
    assert.equal(w.calls.retrieveReservation, 1); }
  // two OPEN identity candidates above the floor: local stop, no read, no new row
  { const b = await booking(); const w = world(b); await sleep(3);
    await requestReadRaw(b.id, ID_T, b.rid); await requestReadRaw(b.id, ID_T, b.rid);
    const r = await step(b, w);
    assert.ok(r.actions.includes("STOP:READ_ROWS_AMBIGUOUS"), JSON.stringify(r.actions));
    assert.deepEqual([w.calls.retrieveReservation, (await reads(b.id, ID_T)).length], [0, 2]); }
});

test("R-C2 (REAL disposable PG): mixed history — a fresh uncited exhausted identity row AND two open same-selector rows above F → STOP:READ_ROWS_AMBIGUOUS; nothing executed, cited, created or changed by selection", async () => {
  const b = await booking(); const w = world(b); await sleep(3);
  const esc = await requestReadRaw(b.id, ID_T, b.rid);
  await F.ownerManagedHistory(db.owner, `UPDATE booking.external_operations SET state = 'escalated', attempts = 10, error_code = 'READ_TRANSPORT_TIMEOUT', updated_at = now()
    WHERE id = $1`, [esc]);
  await requestReadRaw(b.id, ID_T, b.rid); await requestReadRaw(b.id, ID_T, b.rid);
  const op = await recording(b.id);
  const snap = async () => JSON.stringify(await all(`SELECT id, state, attempts, next_attempt_at, updated_at, lease_worker_id FROM booking.external_operations
    WHERE intent_id = $1 AND op_type <> 'guest.notify' ORDER BY id`, [b.id]))
    + await num("SELECT count(*) AS n FROM booking.provider_evidence WHERE intent_id = $1", [b.id])
    + await num("SELECT count(*) AS n FROM booking.recording_assessments WHERE operation_id = $1", [op.id])
    + await num("SELECT count(*) AS n FROM booking.recording_holds WHERE operation_id = $1", [op.id])
    + await num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1", [b.id]);
  const before = await snap();
  const r = await step(b, w);
  assert.ok(r.actions.includes("STOP:READ_ROWS_AMBIGUOUS"), JSON.stringify(r.actions));
  assert.deepEqual([w.calls.retrieveReservation, w.calls.listOfflineCharges, w.calls.createOfflineCharge, r.writes], [0, 0, 0, 0]);
  assert.equal(await snap(), before, "no read / evidence / assessment / hold / case row created or changed by selection");
  assert.equal(await num("SELECT count(*) AS n FROM booking.recording_assessments WHERE identity_read_op = $1", [esc]), 0, "the exhausted row stays uncited");
});
