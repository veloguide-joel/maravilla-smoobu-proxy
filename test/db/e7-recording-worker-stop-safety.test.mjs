// E7 recording worker — OUTER STOP SAFETY (optional `signal` / `deadlineAt` propagation) on a DISPOSABLE local PostgreSQL. OFFLINE / INJECTED
// MOCK only: every provider reply is a SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED fixture built here; nothing reaches a provider. Mirrors the
// reviewed cleanup-worker bounded-call / transaction-admission pattern (PR68 rev2/rev3):
//   * a stop already observable before the step starts → NOTHING (no query, no claim, no call);
//   * a stop is checked after EVERY awaited proof / lease / evidence / claim boundary and immediately before the send → no send after a stop;
//   * a provider reply that settles after a stop is INADMISSIBLE (the started call is an unknown outcome; the late reply is observed in memory only);
//   * a durably succeeded recording (completed with evidence) is RETAINED on a stop; its success event (OFFLINE_CHARGE_RECORDED) is DEFERRED;
//   * a stop observed inside the event transaction's own evidence checks vetoes the event (rollback: state / version unchanged);
//   * the next session reconciles the persisted succeeded / unknown rows from fresh DB facts — never a resend, never a second write;
//   * NO notification is sent anywhere (guest.notify rows are queued bookkeeping only, and none are queued on a stopped path).
// Omitted options preserve the accepted behaviour exactly (the e74b suites stay the regression oracle).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { runRecordingStep } from "../../lib/booking-db/recording-worker.js";
import { isActionToken } from "../../scripts/e7-connected/run-journal-memory.mjs";   // frozen journal grammar (read-only parity check)

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" });
const LABEL = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-A" });
const REF_FIELD = 777007;
let stayN = 500;
const stay = (o = {}) => { stayN += 1; const d = new Date(Date.UTC(2035, 0, 1) + stayN * 6 * 86400000).toISOString().slice(0, 10);
  const e = new Date(Date.UTC(2035, 0, 1) + (stayN * 6 + 3) * 86400000).toISOString().slice(0, 10); return { listingId: 890000 + stayN, from: d, to: e, currency: "USD", ...o }; };
const cfgFor = (listingId) => ({ accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId, paymentMethod: "credit_card", refFieldId: REF_FIELD });
const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
const num = async (sql, p = []) => Number((await db.owner.query(sql, p)).rows[0].n);
const recording = (intentId) => one(`SELECT * FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'hostaway.record_offline_charge'
  ORDER BY split_part(idempotency_key, ':', 3)::int DESC LIMIT 1`, [intentId]);
const intentRow = (id) => one("SELECT state, version, offline_charge_id FROM booking.intents WHERE id = $1", [id]);
const work = (id) => one("SELECT work_worker_id, work_lease_until, next_action_at FROM booking.intent_work WHERE intent_id = $1", [id]);
const notifies = (id) => num("SELECT count(*) AS n FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);
const unknownCase = (id) => num("SELECT count(*) AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND kind = 'OFFLINE_CHARGE_OUTCOME_UNKNOWN' AND status = 'open'", [id]);
const readRows = (id, t) => (db.owner.query(`SELECT state, error_code FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2 ORDER BY created_at`, [id, t])).then((r) => r.rows);
const LIST_T = "hostaway.list_offline_charges";

async function booking() {
  const st = stay();
  const c = await F.captured(db.app, st);
  const i = await one("SELECT ref, hostaway_reservation_id, final_total_minor FROM booking.intents WHERE id = $1", [c.id]);
  return { c, id: c.id, ref: i.ref, rid: i.hostaway_reservation_id, listingId: st.listingId, from: st.from, to: st.to, total: Number(i.final_total_minor), cfg: cfgFor(st.listingId) };
}
/** SYNTHETIC Hostaway world for ONE reservation; `create` / `list` override hooks receive (req, world, opts) */
function world(b, o = {}) {
  const w = { charges: [], calls: { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 }, nextId: 910000 + stayN * 100, list: o.list || null, create: o.create || null };
  w.resv = () => ({ id: Number(b.rid), listingMapId: b.listingId, channelId: 2000, arrivalDate: b.from, departureDate: b.to, totalPrice: b.total / 100,
    currency: "USD", status: "new", customFieldValues: [{ customFieldId: REF_FIELD, value: b.ref }] });
  w.listReply = () => ({ httpStatus: 200, json: { status: "success", result: w.charges.map((x) => ({ ...x })), count: w.charges.length, offset: null } });
  w.addCharge = (req) => { const ch = { id: w.nextId++, listingMapId: b.listingId, reservationId: Number(b.rid), type: "charge", title: req.body.title, currency: "USD",
    paymentMethod: req.body.paymentMethod, amount: req.body.amount, status: "paid", paymentProvider: "offline" }; w.charges.push(ch); return ch; };
  w.executors = {
    label: LABEL,
    retrieveReservation: async () => { w.calls.retrieveReservation += 1; return { httpStatus: 200, json: { status: "success", result: w.resv() } }; },
    listOfflineCharges: async (req, opts) => { w.calls.listOfflineCharges += 1; return w.list ? w.list(req, w, opts) : w.listReply(); },
    createOfflineCharge: async (req, opts) => { w.calls.createOfflineCharge += 1; if (w.create) return w.create(req, w, opts);
      const ch = w.addCharge(req); return { httpStatus: 201, json: { status: "success", result: { ...ch } } }; }
  };
  return w;
}
const step = (b, w, o = {}) => runRecordingStep(o.pool || db.app, { workerId: o.workerId || "rw-stop", env: ENV, listings: new Map([[b.listingId, b.cfg]]), executors: w.executors,
  clock: o.clock || Date.now, intentId: b.id, ...(o.hooks ? { hooks: o.hooks } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}),
  ...("signal" in o ? { signal: o.signal } : {}), ...("deadlineAt" in o ? { deadlineAt: o.deadlineAt } : {}) });
// TEST SETUP (disposable cluster): make the intent due and its work lease free; make pending reads due (never changes attempts / max_attempts)
const due = (b) => db.owner.query("UPDATE booking.intent_work SET next_action_at = now() - interval '1 second', work_worker_id = NULL, work_lease_until = NULL WHERE intent_id = $1", [b.id]);
const readsDue = (b) => db.owner.query(`UPDATE booking.external_operations SET next_attempt_at = now() - interval '1 second' WHERE intent_id = $1 AND retry_class = 'read' AND state = 'pending'`, [b.id]);
async function nextSession(b, w, o = {}) { await due(b); await readsDue(b); return step(b, w, o); }
/** a controllable clock: constant (or, with live: true, the real clock) until armed; then +inc ms per read from `t` (deterministic deadline crossings) */
function fakeClock(base = Date.now(), { live = false } = {}) {
  const c = { t: base, inc: 0, armed: false };
  c.read = () => { if (!c.armed) return live ? Date.now() : c.t; c.t += c.inc; return c.t; };
  c.arm = (inc = 1, from = c.t) => { c.armed = true; c.inc = inc; c.t = from; };
  return c;
}
const trapPool = () => ({ query: async () => { throw new Error("must not query"); }, connect: async () => { throw new Error("must not connect"); } });
const stopActions = (r) => r.actions.filter((a) => a.startsWith("STOP:SIGNAL") || a.startsWith("STOP:DEADLINE"));

// ---------------------------------------------------------------------------------------------
test("S-0 option validation: a non-signal / non-finite deadline is refused before any query; omitted options keep the accepted result shape plus stop: null", async () => {
  const b = await booking(); const w = world(b);
  assert.equal((await step(b, w, { pool: trapPool(), signal: "abort" })).code, "SIGNAL_INVALID");
  assert.equal((await step(b, w, { pool: trapPool(), signal: { aborted: "no" } })).code, "SIGNAL_INVALID");
  assert.equal((await step(b, w, { pool: trapPool(), deadlineAt: NaN })).code, "DEADLINE_INVALID");
  assert.equal((await step(b, w, { pool: trapPool(), deadlineAt: "soon" })).code, "DEADLINE_INVALID");
  assert.deepEqual(w.calls, { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 });
  const r = await step(b, w);                                                // omitted options: the accepted happy path, unchanged
  assert.equal(r.status, "worked", JSON.stringify(r.actions));
  assert.equal(r.stop, null);
  assert.ok(r.actions.includes("RECORDED->confirmed"));
  assert.deepEqual([w.calls.createOfflineCharge, r.writes], [1, 1]);
});

test("S-1 pre-abort → NOTHING: an already-aborted signal / a passed deadline before the step starts → idle, zero queries, zero calls, no claim", async () => {
  const b = await booking(); const w = world(b);
  const ac = new AbortController(); ac.abort();
  const r1 = await step(b, w, { pool: trapPool(), signal: ac.signal });
  assert.deepEqual([r1.status, r1.stop, r1.actions], ["idle", { code: "SIGNAL", where: "start" }, ["STOP:SIGNAL:start"]]);
  const r2 = await step(b, w, { pool: trapPool(), deadlineAt: Date.now() - 1 });
  assert.deepEqual([r2.status, r2.stop], ["idle", { code: "DEADLINE", where: "start" }]);
  assert.deepEqual(w.calls, { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 });
  assert.deepEqual([(await recording(b.id)).state, (await work(b.id)).work_worker_id, await notifies(b.id)], ["pending", null, 0]);
});

test("S-1b a deadline reached after maintenance / recovery but before the work claim → idle, no claim, zero calls", async () => {
  const b = await booking(); const w = world(b);
  const c = fakeClock(); c.arm(1);
  // reads before the pre-claim check: start check, skew t0, skew t1, maintenance now, pre-claim check → the 5th read crosses base+5
  const r = await step(b, w, { clock: c.read, deadlineAt: c.t + 5 });
  assert.equal(r.status, "idle", JSON.stringify(r.actions));
  assert.deepEqual([r.stop.code, r.stop.where], ["DEADLINE", "before_claim_work"]);
  assert.deepEqual(w.calls, { retrieveReservation: 0, listOfflineCharges: 0, createOfflineCharge: 0 });
  assert.equal((await work(b.id)).work_worker_id, null);
});

test("S-2 a stop after EVERY awaited preflight boundary (hooks abort the runner signal) → zero writes, zero sends; a later session completes once", async () => {
  const bounds = ["afterRead", "afterEvidence", "afterAssessment"];
  for (const h of bounds) {
    const b = await booking(); const w = world(b);
    const ac = new AbortController();
    const r = await step(b, w, { signal: ac.signal, hooks: { [h]: async () => ac.abort() } });
    assert.equal(r.status, "worked", h);
    assert.deepEqual([r.stop?.code, r.writes, w.calls.createOfflineCharge, await notifies(b.id)], ["SIGNAL", 0, 0, 0], `${h}: ${JSON.stringify(r.actions)}`);
    assert.equal(stopActions(r).length, 1, h);
    assert.ok(!r.actions.includes("CLAIMED"), `${h}: never claimed after a stop`);
    assert.equal((await recording(b.id)).state, "pending", h);
    // the next session (no stop) completes the SAME pending row exactly once
    const n = await nextSession(b, w);
    assert.ok(n.actions.includes("RECORDED->confirmed"), `${h}: ${JSON.stringify(n.actions)}`);
    assert.deepEqual([w.calls.createOfflineCharge, n.writes, await notifies(b.id)], [1, 1, 1], h);
  }
});

test("S-2b a stop after the recording claim (afterClaim / beforeFinalCheck) → SEND_ABORTED:STOP_SIGNAL, ONE unknown settlement, zero writes, never a resend", async () => {
  for (const h of ["afterClaim", "beforeFinalCheck"]) {
    const b = await booking(); const w = world(b);
    const ac = new AbortController();
    const r = await step(b, w, { signal: ac.signal, hooks: { [h]: async () => ac.abort() } });
    assert.ok(r.actions.includes("CLAIMED") && r.actions.includes("SEND_ABORTED:STOP_SIGNAL") && r.actions.includes("UNKNOWN:SEND_ABORTED_STOP_SIGNAL"), `${h}: ${JSON.stringify(r.actions)}`);
    assert.deepEqual([r.writes, w.calls.createOfflineCharge, (await recording(b.id)).state, await unknownCase(b.id), await notifies(b.id)], [0, 0, "outcome_unknown", 1, 0], h);
    for (let k = 0; k < 2; k++) await nextSession(b, w);
    assert.deepEqual([w.calls.createOfflineCharge, await notifies(b.id)], [0, 0], `${h}: never a resend`);
  }
});

test("S-3 runner-origin signal (lock-loss analogue) fired DURING an awaited proof read → the reply is inadmissible, the read row is unknown, zero writes", async () => {
  const b = await booking();
  const ac = new AbortController();
  const w = world(b, { list: (req, ww) => { ac.abort(); return ww.listReply(); } });   // the runner lost its lock while the LIST proof was in flight
  const r = await step(b, w, { signal: ac.signal });
  assert.equal(r.stop?.code, "SIGNAL", JSON.stringify(r.actions));
  assert.ok(r.actions.some((a) => a === "READ:LIST:TRANSPORT_STOPPED:pending" || a.startsWith("READ:LIST:TRANSPORT_STOPPED")), JSON.stringify(r.actions));
  assert.ok(!r.actions.includes("ASSESSED:eligible") && !r.actions.includes("CLAIMED"));
  const rows = await readRows(b.id, LIST_T);
  assert.ok(rows.some((x) => x.error_code === "READ_TRANSPORT_STOPPED"), JSON.stringify(rows));
  assert.deepEqual([r.writes, w.calls.createOfflineCharge, (await recording(b.id)).state, await notifies(b.id)], [0, 0, "pending", 0]);
});

test("S-4 a stop while the WRITE is in flight → the applied reply is INADMISSIBLE: ONE unknown settlement, late reply observed in memory only, never a resend, no notify", async () => {
  const b = await booking();
  const ac = new AbortController();
  const w = world(b, { create: (req, ww) => { const ch = ww.addCharge(req); ac.abort(); return { httpStatus: 201, json: { status: "success", result: { ...ch } } }; } });
  const r = await step(b, w, { signal: ac.signal });
  assert.ok(r.actions.includes("UNKNOWN:WRITE_STOPPED_SIGNAL"), JSON.stringify(r.actions));
  assert.ok(!r.actions.includes("COMPLETED") && !r.actions.some((a) => a.startsWith("RECORDED")));
  assert.deepEqual([r.writes, w.calls.createOfflineCharge, w.charges.length, (await recording(b.id)).state, await unknownCase(b.id), await notifies(b.id)], [1, 1, 1, "outcome_unknown", 1, 0]);
  assert.deepEqual(await r.late, { kind: "late_reply", settled: "fulfilled", httpStatus: 201 });
  assert.equal((await intentRow(b.id)).state, "payment_captured");
  // next sessions: the persisted unknown row is reconciled read-only (no new write, no notify)
  for (let k = 0; k < 2; k++) { const n = await nextSession(b, w); assert.ok(n.actions.includes("STOP:RECORDING_OUTCOME_UNKNOWN"), JSON.stringify(n.actions)); }
  assert.deepEqual([w.calls.createOfflineCharge, w.charges.length, await notifies(b.id)], [1, 1, 0]);
});

test("S-5 applied-but-lost write under a stop (provider applied, transport failed, runner stopped) → unknown, charge stays exactly once at the provider, never a resend", async () => {
  const b = await booking();
  const ac = new AbortController();
  const w = world(b, { create: (req, ww) => { ww.addCharge(req); ac.abort(); throw new Error("ECONNRESET"); } });
  const r = await step(b, w, { signal: ac.signal });
  assert.ok(r.actions.includes("UNKNOWN:WRITE_STOPPED_SIGNAL"), JSON.stringify(r.actions));
  assert.deepEqual(await r.late, { kind: "late_reply", settled: "rejected", httpStatus: null });
  assert.deepEqual([r.writes, w.charges.length, (await recording(b.id)).state, await unknownCase(b.id)], [1, 1, "outcome_unknown", 1]);
  for (let k = 0; k < 2; k++) await nextSession(b, w);
  assert.deepEqual([w.calls.createOfflineCharge, w.charges.length, await notifies(b.id)], [1, 1, 0]);
});

test("S-6 a stop AFTER the durable completion → the succeeded row is RETAINED, the success event is DEFERRED (no transition, no notify); the next session finalises once, zero writes", async () => {
  const b = await booking(); const w = world(b);
  const ac = new AbortController();
  const r = await step(b, w, { signal: ac.signal, hooks: { afterComplete: async () => ac.abort() } });
  assert.ok(r.actions.includes("COMPLETED") && r.actions.includes("COMPLETED:EVENT_DEFERRED") && !r.actions.includes("RECORDING_ROW_SUCCEEDED_EVENT_DEFERRED"), JSON.stringify(r.actions));
  assert.ok(r.actions.every(isActionToken), `every stop-path action is a frozen-grammar token: ${JSON.stringify(r.actions)}`);   // ROOT 5883244600 option (a)
  assert.ok(!r.actions.some((a) => a.startsWith("RECORDED")));
  const op = await recording(b.id);
  assert.deepEqual([op.state, op.settled_evidence_id !== null, op.result_ref !== null, (await intentRow(b.id)).state, await notifies(b.id)], ["succeeded", true, true, "payment_captured", 0]);
  const n = await nextSession(b, w);
  assert.ok(n.actions.includes("RECORDED->confirmed"), JSON.stringify(n.actions));
  assert.deepEqual([n.writes, w.calls.createOfflineCharge, (await intentRow(b.id)).state, await notifies(b.id)], [0, 1, "confirmed", 1]);
});

test("S-7 a stop inside the event transaction (before AND after its own awaited checks) vetoes OFFLINE_CHARGE_RECORDED (rollback: state / version unchanged); the row stays succeeded; the next session finalises", async () => {
  // clock reads on the event path after completion: after_complete check, entry gate, event time, in-tx gate, work-lease check, post-checks gate →
  // arming the +1 ms/read clock at deadline-4 crosses it at the in-tx gate, at deadline-6 at the post-checks gate
  for (const [offset, where] of [[4, "in_tx_OFFLINE_CHARGE_RECORDED"], [6, "in_tx_after_checks_OFFLINE_CHARGE_RECORDED"]]) {
    const b = await booking(); const w = world(b);
    const c = fakeClock(Date.now(), { live: true });                       // the real clock until completion (the confirming read must follow the dispatch)
    const deadlineAt = Date.now() + 20 * 1000;                             // inside every lease (work 120 s, op 90 s): only the deadline can stop the event
    const before = await intentRow(b.id);
    const r = await step(b, w, { clock: c.read, deadlineAt, hooks: { afterComplete: async () => c.arm(1, deadlineAt - offset) } });
    assert.ok(r.actions.includes("COMPLETED") && r.actions.includes("RECORDED!STOPPED"), `${where}: ${JSON.stringify(r.actions)}`);
    assert.deepEqual(r.stop, { code: "DEADLINE", where }, JSON.stringify(r.stop));
    const after = await intentRow(b.id);
    assert.deepEqual([after.state, after.version, after.offline_charge_id, (await recording(b.id)).state, await notifies(b.id)], ["payment_captured", before.version, null, "succeeded", 0], where);
    const n = await nextSession(b, w);
    assert.ok(n.actions.includes("RECORDED->confirmed"), `${where}: ${JSON.stringify(n.actions)}`);
    assert.deepEqual([n.writes, w.calls.createOfflineCharge, await notifies(b.id)], [0, 1, 1], where);
  }
});

test("S-8 the deadline passes DURING the final (confirming) evidence read → the reply is inadmissible: unknown settlement with the write retained as unknown, no completion, no event, never a resend", async () => {
  const b = await booking();
  const c = fakeClock();
  const w = world(b, { list: (req, ww) => { if (ww.calls.listOfflineCharges === 2) c.arm(1000); return ww.listReply(); } });   // the 2nd LIST is the confirming read
  const r = await step(b, w, { clock: c.read, deadlineAt: c.t + 500 });
  assert.ok(r.actions.includes("UNKNOWN:CONFIRM_TRANSPORT_STOPPED"), JSON.stringify(r.actions));
  assert.equal(r.stop?.code, "DEADLINE");
  assert.ok(!r.actions.includes("COMPLETED") && !r.actions.some((a) => a.startsWith("RECORDED")));
  assert.deepEqual([r.writes, w.charges.length, (await recording(b.id)).state, await unknownCase(b.id), (await intentRow(b.id)).state, await notifies(b.id)],
    [1, 1, "outcome_unknown", 1, "payment_captured", 0]);
  for (let k = 0; k < 2; k++) await nextSession(b, w);
  assert.deepEqual([w.calls.createOfflineCharge, w.charges.length, await notifies(b.id)], [1, 1, 0]);
});

// ---------------------------------------------------------------------------------------------
// ROOT 5883086133 F1 — exact reproductions: a stop newly observed AFTER the admitted reply and BEFORE the completion must not be crossed
// by fresh proof / completion. The sent write stays an uncertain lineage (outcome_unknown + case), one provider write ever, no completion, no
// success event, no notification; already-committed read rows / evidence are kept as truth; a later session never resends.

const uncertainLineage = async (b, w, r, label) => {
  assert.ok(!r.actions.includes("COMPLETED") && !r.actions.some((a) => a.startsWith("RECORDED")), `${label}: ${JSON.stringify(r.actions)}`);
  assert.ok(r.actions.some((a) => /^UNKNOWN:CONFIRM_STOPPED_(SIGNAL|DEADLINE)$/.test(a)), `${label}: ${JSON.stringify(r.actions)}`);
  const op = await recording(b.id);
  assert.deepEqual([r.writes, w.calls.createOfflineCharge, w.charges.length, op.state, op.settled_evidence_id, await unknownCase(b.id), (await intentRow(b.id)).state, await notifies(b.id)],
    [1, 1, 1, "outcome_unknown", null, 1, "payment_captured", 0], label);
  for (let k = 0; k < 2; k++) { const n = await nextSession(b, w); assert.ok(n.actions.includes("STOP:RECORDING_OUTCOME_UNKNOWN"), `${label}: ${JSON.stringify(n.actions)}`); }
  assert.deepEqual([w.calls.createOfflineCharge, w.charges.length, await notifies(b.id), (await recording(b.id)).state], [1, 1, 0, "outcome_unknown"], `${label}: later sessions`);
};

test("S-9 ROOT repro A: a stop in afterConfirmEvidence (SIGNAL and DEADLINE) → no completion after the stop; uncertain lineage; one write ever; no notify", async () => {
  { const b = await booking(); const w = world(b); const ac = new AbortController();
    const r = await step(b, w, { signal: ac.signal, hooks: { afterConfirmEvidence: async () => ac.abort() } });
    assert.deepEqual(r.stop, { code: "SIGNAL", where: "before_complete" }, JSON.stringify(r.actions));
    await uncertainLineage(b, w, r, "A/signal"); }
  { const b = await booking(); const w = world(b); const c = fakeClock(Date.now(), { live: true });
    const r = await step(b, w, { clock: c.read, deadlineAt: Date.now() + 20 * 1000, hooks: { afterConfirmEvidence: async () => c.arm(30000, Date.now()) } });
    assert.deepEqual(r.stop, { code: "DEADLINE", where: "before_complete" }, JSON.stringify(r.actions));
    await uncertainLineage(b, w, r, "A/deadline"); }
});

test("S-10 ROOT repro B: a stop during the post-reply loadFacts proof (real pool wrapper; no hook) (SIGNAL and DEADLINE) → no fresh proof / completion after the stop; uncertain lineage", async () => {
  /** real db.app pool whose query() fires `onIntentsSelect` once, after the first SELECT touching booking.intents once armed, BEFORE returning the awaited result */
  const wrapped = (onIntentsSelect) => { const st = { armed: false, fired: false }; const pool = {
    query: async (...a) => { const r = await db.app.query(...a); const sql = typeof a[0] === "string" ? a[0] : a[0]?.text ?? "";
      if (st.armed && !st.fired && /SELECT[\s\S]*booking\.intents\b/.test(sql)) { st.fired = true; await onIntentsSelect(); } return r; },
    connect: (...a) => db.app.connect(...a) }; return { pool, st }; };
  { const b = await booking(); const ac = new AbortController();
    const { pool, st } = wrapped(async () => ac.abort());
    const w = world(b, { list: (req, ww) => { if (ww.calls.listOfflineCharges === 2) st.armed = true; return ww.listReply(); } });   // armed by the confirming read
    const r = await step(b, w, { pool, signal: ac.signal });
    assert.ok(st.fired && r.stop?.code === "SIGNAL" && r.stop.where === "after_confirm_facts", JSON.stringify([st, r.stop, r.actions]));
    await uncertainLineage(b, w, r, "B/signal"); }
  { const b = await booking(); const c = fakeClock(Date.now(), { live: true });
    const { pool, st } = wrapped(async () => c.arm(30000, Date.now()));
    const w = world(b, { list: (req, ww) => { if (ww.calls.listOfflineCharges === 2) st.armed = true; return ww.listReply(); } });
    const r = await step(b, w, { pool, clock: c.read, deadlineAt: Date.now() + 20 * 1000 });
    assert.ok(st.fired && r.stop?.code === "DEADLINE" && r.stop.where === "after_confirm_facts", JSON.stringify([st, r.stop, r.actions]));
    await uncertainLineage(b, w, r, "B/deadline"); }
});
