// E7 M2-C — journalled TEST-abort bridge on a THROWAWAY LOCAL PostgreSQL (migrations 0001–0017 incl. the 0017 local candidate; never a
// shared DB). Runtime code as mv_booking_app; FAKE Stripe + Hostaway executors for the accepted compensation worker (no network / SDK /
// credentials). The v2 journal is the in-memory one. db.owner is used only to read / plant an explicitly labelled conflicting claim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { startMigratedDatabase } from "./harness.mjs";
import * as F from "./fixtures.mjs";
import { applyEvent, loadIntent, recordHostawayCreateResult } from "../../lib/booking-db/repo.js";
import { claimNextOperation, completeOperation } from "../../lib/booking-db/operations.js";
import { runCleanupStep, OPS } from "../../lib/booking-db/compensation-worker.js";
import { validateAdapterConfig } from "../../lib/hostaway-reservations.js";
import { requestTestAbort } from "../../lib/booking-db/test-abort.js";
import { buildAbortExpectation, executeOperatorAbort } from "../../scripts/e7-operator/test-abort.mjs";
import * as V2 from "../../scripts/e7-connected/run-journal-memory-v2.mjs";
import { runTestAbortBridge } from "../../scripts/e7-connected/run-test-abort.mjs";
import { validateGuardDeps, createGuard } from "../../scripts/e7-connected/run-guard.mjs";
import { validateRunManifestV2 } from "../../scripts/e7-connected/run-manifest-v2.mjs";

let db;
before(async () => { db = await startMigratedDatabase(); });
after(async () => { await db.close(); });

const LISTING = 606998; const ACCT = "acct_1TestAbortWorker"; const REF_FIELD = 777011; const TZ = "America/Mazatlan"; const MIN = F.MIN;
const ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" });
const CLEAN_ENV = Object.freeze({ VERCEL_ENV: "development", MV_E7_COMPENSATION_WORKER: "enabled" });
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
let stayN = 0;
const nextStay = () => { stayN += 1; return { listingId: LISTING, currency: "USD", from: addDays("2027-05-01", 5 * stayN), to: addDays("2027-05-01", 5 * stayN + 3) }; };
const hex = () => randomUUID().replace(/-/g, "").slice(0, 12);
const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };

/** reservation_confirmed TEST intent (accepted transitions only) + its v2 abort-plan manifest + operator expectation */
async function confirmed(connection) {
  const stay = nextStay();
  const p = await F.pending(db.app, stay);
  const piId = `pi_ABRT${hex()}`;
  F.ok(await applyEvent(db.app, p.id, F.authEvent(p.sessionId, piId, 5, { currency: "usd" }), { now: F.at(5), actor: "webhook" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_STARTED", workerId: "w1", recheck: { bookable: true, priceSame: true } }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_DISPATCHED", workerId: "w1" }, { now: F.at(6), actor: "worker", workerId: "w1" }));
  const rid = F.nextReservationId() + 62000000;
  const op = await F.claimOp(db.app, p.id, "hostaway.create_reservation", F.at(6));
  await recordHostawayCreateResult(db.app, p.id, { httpStatus: 201, reservation: F.reservationFor(stay, rid) }, { now: F.at(7) });
  F.ok(await completeOperation(db.app, op.id, { workerId: "w1", now: F.at(7), outcome: { status: "succeeded", resultRef: rid } }));
  F.ok(await applyEvent(db.app, p.id, { type: "RESERVATION_SUCCEEDED", reservation: F.reservationFor(stay, rid) }, { now: F.at(7), actor: "worker" }));
  const i = await loadIntent(db.app, p.id);
  assert.equal(i.status, "reservation_confirmed");
  const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [p.id])).rows[0].id;
  const e = buildAbortExpectation({ intentId: p.id, expectedVersion: i.version, listingId: LISTING, from: stay.from, to: stay.to, guests: i.guests, currency: "USD",
    finalTotalMinor: i.price.finalTotalMinor, authorizedMinor: i.payment.amountMinor, paymentIntentId: piId, sessionId: p.sessionId, attemptId: pa, reservationId: String(rid),
    approvalRef: "synthetic-m2c-pg" });
  const manifest = { version: "e7-run-manifest-v2", runId: `synthetic-m2c-${hex()}`, intentId: p.id, baselineCommit: "0".repeat(40), synthetic: true,
    providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: LISTING, currency: "USD", refFieldId: REF_FIELD, timeZone: TZ, connection },
    expectedRef: "MV-SYNTH0D", stay: { arrival: stay.from, departure: stay.to, guests: i.guests }, amountMinor: i.price.finalTotalMinor, pricing: { rateBps: 1000 },
    stripeAccountId: ACCT, hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" }, phases: { capture: false, recording: false, testAbortAfterReservation: true },
    paymentMethod: null, cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: [...CK[connection]] };
  assert.equal(validateRunManifestV2(manifest).ok, true);
  return { id: p.id, piId, rid: String(rid), stay, e: { ...e }, intent: i, ref: i.ref, paymentAttemptId: pa, manifest, connection };
}
// ---- journal records (a SIMULATED run-core producer; v2 hash computed independently) ------------------------------------------------
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const H2 = (r) => createHash("sha256").update(`e7-run-journal-v2\n${canon(r)}`, "utf8").digest("hex");
const W0 = { create: 0, capture: 0, record: 0, void: 0, cancel: 0 };
function producer(a, j) {
  const id = { manifestVersion: "e7-run-manifest-v2", connection: a.connection, runId: a.manifest.runId, intentId: a.id, baselineCommit: a.manifest.baselineCommit, manifestHash: validateRunManifestV2(a.manifest).hash };
  const st = { head: null };
  const put = async (event, body) => {
    const recs = (await j.journal.read()).records; const last = recs.at(-1);
    const r = { v: 2, seq: recs.length + 1, prevHash: last ? H2(last) : "0".repeat(64), ...id, at: 1_800_000_000_000 + recs.length, event, ...body };
    st.head = await j.journal.append(r); return st.head;
  };
  return { st, put, id };
}
async function reservedJournal(a, opts = {}) {
  const j = V2.createMemoryJournalV2({ manifest: a.manifest, ...opts }); assert.equal(j.ok, true, j.code);
  const P = producer(a, j); const K = CK[a.connection];
  await P.put("RUN_STARTED", {}); await P.put("ATTESTED", { attestation: { checkpoint: K[0], evidenceRef: "synthetic/baseline" } });
  await P.put("STEP_STARTED", { phase: "reservation", step: 1, factory: { phase: "reservation", reservationId: null } });
  await P.put("STEP_ENDED", { phase: "reservation", step: 1, result: "worked", state: "reservation_confirmed", actions: ["RESERVATION_SUCCEEDED->reservation_confirmed"], unlistedActions: 0, refusals: [], writes: { ...W0, create: 1 } });
  await P.put("PHASE_ENDED", { phase: "reservation", state: "reservation_confirmed" });
  await P.put("ATTESTED", { attestation: { checkpoint: K[1], evidenceRef: "synthetic/blocked" } });
  return { j, P, K, head: { ...P.st.head } };
}
// ---- fake providers for the accepted compensation worker (labelled COPY of the accepted e7-test-abort harness) ---------------------
function world() {
  const w = { calls: [], pis: new Map(), res: new Map(), voids: [], cancels: [], voidMode: "ok", cancelMode: "ok" };
  w.piObj = (p) => ({ object: "payment_intent", id: p.id, livemode: false, status: p.status, capture_method: "manual", amount: p.amount, amount_received: 0,
    amount_capturable: p.status === "requires_capture" ? p.amount : 0, currency: "usd", metadata: { mv_intent_id: p.intentId, mv_payment_attempt_id: p.attemptId },
    latest_charge: { object: "charge", id: p.chargeId, payment_intent: p.id, status: "succeeded", paid: true, captured: false, amount: p.amount, amount_captured: 0,
      amount_refunded: 0, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: p.captureBeforeSec } } } });
  const full = (r) => ({ id: r.id, listingMapId: r.listingMapId, channelId: 2000, arrivalDate: r.arrivalDate, departureDate: r.departureDate, totalPrice: r.totalPrice,
    currency: r.currency, status: r.status, customFieldValues: [{ customFieldId: REF_FIELD, value: r.ref }] });
  w.executors = {
    retrieveAccount: async () => { w.calls.push("ACCOUNT"); return { object: "account", id: ACCT }; },
    retrievePaymentIntent: async (id) => { w.calls.push(`PI ${id}`); return w.piObj(w.pis.get(id)); },
    cancelPaymentIntent: async (id, params, o = {}) => { w.calls.push(`VOID ${id}`); w.voids.push({ id, key: o.idempotencyKey }); const p = w.pis.get(id);
      if (w.voidMode === "ok") { p.status = "canceled"; return w.piObj(p); } if (w.voidMode === "replyOnly") return { ...w.piObj(p), status: "canceled" }; throw new Error(w.voidMode); },
    retrieveReservation: async (req) => { w.calls.push(`RES ${req.path}`); const r = w.res.get(Number(/\/reservations\/(\d+)$/.exec(req.path)[1]));
      return r ? { httpStatus: 200, json: { status: "success", result: full(r) } } : { httpStatus: 404, json: { status: "fail" } }; },
    lookupPage: async (req) => { w.calls.push(`LOOKUP ${req.query.listingId}`); if (req.query.afterId) return { httpStatus: 200, json: { status: "success", result: [] } };
      return { httpStatus: 200, json: { status: "success", result: [...w.res.values()].filter((r) => r.listingMapId === req.query.listingId && r.arrivalDate === req.query.arrivalStartDate).map(full) } }; },
    cancelReservation: async (req) => { w.calls.push(`CANCEL ${req.path}`); w.cancels.push(req.path); const r = w.res.get(Number(/\/reservations\/(\d+)\/statuses\/cancelled$/.exec(req.path)[1]));
      if (w.cancelMode === "ok") { r.status = "cancelled"; return { httpStatus: 200, json: { status: "success", result: full(r) } }; }
      if (w.cancelMode === "replyOnly") return { httpStatus: 200, json: { status: "success", result: { ...full(r), status: "cancelled" } } }; throw new Error(w.cancelMode); }
  };
  return w;
}
function attachWorld(w, a) {
  w.pis.set(a.piId, { id: a.piId, intentId: a.id, attemptId: a.paymentAttemptId, status: "requires_capture", amount: a.intent.payment.amountMinor, chargeId: `ch_test_${a.id.slice(0, 8)}`,
    captureBeforeSec: a.intent.payment.captureBefore / 1000 });
  w.res.set(Number(a.rid), { id: Number(a.rid), listingMapId: LISTING, arrivalDate: a.stay.from, departureDate: a.stay.to, totalPrice: a.intent.price.finalTotalMinor / 100, currency: "USD", status: "new", ref: a.ref });
}
function harness(w) {
  const clk = { t: F.at(20) };
  const opts = (extra = {}) => ({ workerId: "cw1", env: CLEAN_ENV, adapterConfig: validateAdapterConfig({ allowedListingIds: [LISTING], refFieldId: REF_FIELD, channelId: 2000, currency: "USD" }),
    listings: new Map([[LISTING, { currency: "USD", timeZone: TZ }]]), executors: w.executors, clock: () => clk.t, stripeAccountId: ACCT, ...extra });
  return { clk, step: (extra = {}) => runCleanupStep(db.app, opts(extra)) };
}
const realGuard = () => createGuard(validateGuardDeps({ monotonic: () => performance.now(), timers: { arm: (ms) => { let h; const promise = new Promise((r) => { h = setTimeout(r, ms); });
  return { promise, cancel: () => clearTimeout(h) }; } } }).deps);
const state = async (id) => (await loadIntent(db.app, id)).status;
const claimHeld = async (id) => (await db.app.query("SELECT count(*)::int AS n FROM booking.inventory_claims WHERE intent_id = $1 AND released_at IS NULL", [id])).rows[0].n === 1;
const capRows = async (id) => (await db.owner.query("SELECT id, state, attempts, dispatched_at, lease_worker_id, lease_until, updated_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = $2", [id, OPS.CAPTURE])).rows;
const appliedAborts = async (id) => F.count(db.app, "SELECT count(*) AS n FROM booking.intent_applied_events WHERE intent_id = $1 AND event_type = 'TEST_ABORT_REQUESTED'", [id]);
/** the accepted helper wrapped ONLY to count calls (the real requestTestAbort runs) */
const counted = (s, extra = {}) => ({ requestTestAbort: (...args) => { s.n += 1; return requestTestAbort(...args); }, ...extra });
const bridge = (a, jr, over = {}) => runTestAbortBridge({ manifest: a.manifest, operator: a.e, journal: jr.j.journal, trustedHead: jr.head, pool: db.app, env: ENV, guard: realGuard(),
  now: F.at(9), ...over });

test("B1 happy path (disconnected): start ACK → ONE helper call → verified postcheck → ACKed receipt; then the accepted worker proves BOTH legs and the journalled cleanup releases (0017); capture row untouched + unclaimable", async () => {
  const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 };
  const cap0 = await capRows(a.id);
  const r = await bridge(a, jr, { operatorDeps: counted(s) });
  assert.equal(r.outcome, "ABORT_ACCEPTED_JOURNALED", JSON.stringify(r));
  assert.deepEqual([r.cleanupPermitted, r.operatorCoreInvocations, s.n, r.operatorOutcome, r.dbAbortApplied], [true, 1, 1, "REQUESTED", true]);
  assert.deepEqual([r.startAck.seq, r.receiptAck.seq], [jr.head.seq + 1, jr.head.seq + 2]);
  assert.deepEqual([r.requestHelperInvocations, r.receiptLanding, r.trustedHead], [1, "ACKED", r.receiptAck], "core = 1 call, helper = 1 call; trusted head advanced ONLY on the receipt ACK");
  const pc = r.postcheck;
  assert.deepEqual([pc.appliedEvents, pc.appliedEventType, pc.intentState, pc.intentReason, pc.capture, pc.claimHeld, pc.openCases, pc.legs],
    [1, "TEST_ABORT_REQUESTED", "capture_failed", "TEST_ABORT_REQUESTED", "pending:0:false:false", true, 0, "false/false"]);
  assert.deepEqual([...pc.queued], ["alert.owner:pending:0", "hostaway.cancel_reservation:pending:0", "stripe.void_payment_intent:pending:0"]);
  const rd = await jr.j.journal.read();
  assert.deepEqual(rd.records.slice(-2).map((x) => x.event), ["ABORT_REQUEST_STARTED", "ABORT_ACCEPTED"]);
  assert.equal(V2.journalFactsV2(rd.records, a.manifest, { trustedHead: r.receiptAck }).facts.cleanupEntryPermitted, true);
  // the accepted compensation worker settles both legs (fake providers); the producer journals the cleanup it observed
  const w = world(); attachWorld(w, a); const h = harness(w);
  for (let k = 0; k < 10 && (await state(a.id)) !== "cancelled"; k++) { await h.step({ intentId: a.id }); h.clk.t += MIN; }
  assert.equal(await state(a.id), "cancelled"); assert.deepEqual([w.voids.length, w.cancels.length], [1, 1]);
  assert.equal(await claimHeld(a.id), false, "released only after BOTH legs (0017)");
  assert.deepEqual(await capRows(a.id), cap0, "capture row byte-identical");
  assert.equal(await claimNextOperation(db.app, { workerId: "x", now: F.at(900), intentId: a.id, opTypes: [OPS.CAPTURE] }), null, "never claimable (0007)");
  assert.equal(w.calls.some((c) => /capture|refund/i.test(c)), false);
  const P = jr.P;
  await P.put("STEP_STARTED", { phase: "cleanup", step: 1, factory: { phase: "cleanup", reservationId: null } });
  await P.put("STEP_ENDED", { phase: "cleanup", step: 1, result: "worked", state: "cancelled", actions: ["VOID_SUCCEEDED", "RESERVATION_CANCELLED->cancelled"], unlistedActions: 0, refusals: [], writes: { ...W0, void: 1, cancel: 1 } });
  await P.put("PHASE_ENDED", { phase: "cleanup", state: "cancelled" });
  await P.put("ATTESTED", { attestation: { checkpoint: "CALENDAR_REOPENED", evidenceRef: "synthetic/reopened" } });
  const end = await P.put("RUN_ENDED", { outcome: "ENDED_RELEASED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 } });
  const fin = V2.validateJournalV2((await jr.j.journal.read()).records, a.manifest, { trustedHead: end });
  assert.deepEqual([fin.ok, fin.status, fin.anchored], [true, "ENDED", true]);
  // a second bridge call on the same run can never re-request (journal no longer abort-ready)
  const again = await bridge(a, jr, { trustedHead: end, operatorDeps: counted(s) });
  assert.deepEqual([again.outcome, again.code, again.operatorCoreInvocations, s.n], ["REFUSED_BEFORE_START", "JOURNAL_NOT_ABORT_READY", 0, 1]);
});

test("B2 one leg unknown (airbnb): void reply-only → reconciliation_required; claim HELD; the journal cannot end the cleanup or release; the mode's reopened is refused; zero resends", async () => {
  const a = await confirmed("airbnb"); const jr = await reservedJournal(a); const s = { n: 0 };
  const r = await bridge(a, jr, { operatorDeps: counted(s) }); assert.equal(r.outcome, "ABORT_ACCEPTED_JOURNALED", r.code);
  const w = world(); attachWorld(w, a); w.voidMode = "replyOnly"; const h = harness(w);
  for (let k = 0; k < 25 && !["cancelled", "reconciliation_required"].includes(await state(a.id)); k++) { await h.step({ intentId: a.id }); h.clk.t += 3 * MIN; }
  assert.equal(await state(a.id), "reconciliation_required"); assert.equal(await claimHeld(a.id), true);
  const P = jr.P;
  await P.put("STEP_STARTED", { phase: "cleanup", step: 1, factory: { phase: "cleanup", reservationId: null } });
  await P.put("STEP_ENDED", { phase: "cleanup", step: 1, result: "worked", state: "reconciliation_required", actions: ["VOID_CLAIMED"], unlistedActions: 0, refusals: [], writes: { ...W0, void: 1, cancel: 1 } });
  const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { return e.code; } };
  const recs = (await jr.j.journal.read()).records; const last = recs.at(-1);
  const mk = (event, body) => ({ v: 2, seq: recs.length + 1, prevHash: H2(last), ...P.id, at: 1_900_000_000_000, event, ...body });
  assert.equal(await codeOf(jr.j.journal.append(mk("PHASE_ENDED", { phase: "cleanup", state: "reconciliation_required" }))), "ORDER_INVALID");
  assert.equal(await codeOf(jr.j.journal.append(mk("ATTESTED", { attestation: { checkpoint: "AIRBNB_REOPENED", evidenceRef: "synthetic/reopened" } }))), "ORDER_INVALID");
  assert.equal(await codeOf(jr.j.journal.append(mk("RUN_ENDED", { outcome: "ENDED_RELEASED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 } }))), "ORDER_INVALID");
  assert.equal(w.voids.length, 1, "no resend"); assert.equal(s.n, 1);
});

test("B3 lost DB reply: the abort APPLIED but the reply is lost → ABORT_OUTCOME_UNKNOWN, NO resend, no receipt, no cleanup permission; read-only facts show the applied state for recovery", async () => {
  const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 };
  const r = await bridge(a, jr, { operatorDeps: counted(s, { afterReply: () => { throw new Error("reply lost"); } }) });
  assert.equal(r.outcome, "ABORT_OUTCOME_UNKNOWN", JSON.stringify(r));
  assert.deepEqual([r.cleanupPermitted, r.operatorCoreInvocations, s.n, r.receiptAck, r.operatorOutcome], [false, 1, 1, null, "REQUEST_OUTCOME_UNKNOWN"]);
  assert.equal(await appliedAborts(a.id), 1, "the DB really applied it (exactly once)");
  assert.deepEqual([r.postcheck.intentState, r.postcheck.appliedEvents], ["capture_failed", 1], "diagnostic facts preserved");
  const f = V2.journalFactsV2((await jr.j.journal.read()).records, a.manifest).facts;
  assert.deepEqual([f.abortStarted, f.abortAccepted, f.cleanupEntryPermitted], [true, false, false]);
  const again = await bridge(a, jr, { trustedHead: r.startAck, operatorDeps: counted(s) });
  assert.deepEqual([again.code, again.operatorCoreInvocations, s.n], ["JOURNAL_NOT_ABORT_READY", 0, 1], "never re-requested");
});

test("B4 definite refusal (gate closed) → ABORT_REFUSED: DB unchanged, no receipt, no cleanup; a capture claimed before the bridge → refused by the accepted precheck with ZERO helper writes", async () => {
  const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 };
  const r = await bridge(a, jr, { env: { VERCEL_ENV: "development" }, operatorDeps: counted(s) });
  assert.deepEqual([r.outcome, r.operatorOutcome, r.cleanupPermitted, r.receiptAck, r.dbAbortApplied, s.n], ["ABORT_REFUSED", "REFUSED", false, null, false, 1]);
  assert.equal(await state(a.id), "reservation_confirmed"); assert.equal(await appliedAborts(a.id), 0);
  const b = await confirmed("airbnb"); const jb = await reservedJournal(b); const s2 = { n: 0 };
  const op = await claimNextOperation(db.app, { workerId: "cap", now: F.at(9), opTypes: [OPS.CAPTURE], intentId: b.id });
  assert.ok(op && op.op_type === OPS.CAPTURE, "capture claimed (possibly sent)");
  const rb = await bridge(b, jb, { operatorDeps: counted(s2) });
  assert.deepEqual([rb.outcome, rb.operatorOutcome, rb.code, rb.operatorCoreInvocations, s2.n, rb.cleanupPermitted], ["ABORT_REFUSED", "NOT_EXECUTED_NOT_ELIGIBLE", "CAPTURE_NOT_PRISTINE", 1, 0, false]);
  assert.deepEqual([rb.requestHelperInvocations, rb.dbAbortApplied, rb.postcheck.appliedEvents, rb.postcheck.transition], [0, false, 0, "rows:0"], "false = OBSERVED absent at the read, not assumed");
  assert.equal(await state(b.id), "reservation_confirmed"); assert.equal(await appliedAborts(b.id), 0);
});

/** a guard over a FAKE monotonic clock and a FAKE timer list: time only moves when the test advances it (bounded, never run-until-green) */
function fakeClockGuard() {
  const f = { t: 0, timers: [] };
  f.guard = createGuard(validateGuardDeps({ monotonic: () => f.t, timers: { arm: (ms) => { let res; const promise = new Promise((x) => { res = x; });
    const e = { due: f.t + ms, res, live: true }; f.timers.push(e); return { promise, cancel: () => { e.live = false; } }; } } }).deps);
  f.advance = (ms) => { f.t += ms; for (const e of f.timers) if (e.live && e.due <= f.t) { e.live = false; e.res(undefined); } };
  return f;
}
const waitFor = async (pred, label) => { for (let k = 0; k < 300; k++) { if (await pred()) return; await new Promise((x) => setTimeout(x, 10)); } assert.fail(`bounded wait expired: ${label}`); };

test("B5 receipt uncertainty after a VERIFIED DB abort — reject / hang / late / landed_hang / landed-with-malformed-ACK / landed-with-lost-ACK: STOPPED_RECEIPT_UNACKED, never resent, cleanup NOT permitted, DB outcome preserved, trusted head never advances; an unACKed landed receipt is an extra tail the trusted head refuses", async () => {
  for (const mode of ["reject", "hang", "late", "landed_hang", "badack", "lostack"]) {
    const a = await confirmed(mode === "late" || mode === "lostack" ? "airbnb" : "disconnected"); const s = { n: 0 };
    const injected = ["reject", "hang", "late", "landed_hang"].includes(mode);
    const jr = await reservedJournal(a, injected ? { faults: { append: { 8: mode } } } : {});                 // 6 producer appends + start (7) + receipt (8)
    let calls = 0;
    const journal = injected ? jr.j.journal : Object.freeze({ read: jr.j.journal.read, append: async (rec) => { calls += 1; const ack = await jr.j.journal.append(rec);
      if (calls === 1) return ack;                                                                             // the start record: honest ACK
      return mode === "badack" ? { seq: ack.seq, hash: "0".repeat(64) } : undefined; } });                    // receipt LANDED; ACK malformed / lost
    const fg = fakeClockGuard();
    const p = bridge(a, jr, { journal, guard: fg.guard, operatorDeps: counted(s) });
    if (["hang", "late", "landed_hang"].includes(mode)) { await waitFor(() => jr.j.controls.appendCalls() >= 8, mode); fg.advance(5_001); }
    const r = await p;
    assert.equal(r.outcome, "STOPPED_RECEIPT_UNACKED", `${mode}: ${JSON.stringify(r)}`);
    assert.deepEqual([r.cleanupPermitted, r.dbAbortApplied, r.operatorCoreInvocations, r.requestHelperInvocations, s.n, r.operatorOutcome, r.receiptAck],
      [false, true, 1, 1, 1, "REQUESTED", null], mode);
    assert.equal(r.code, { reject: "APPEND_REJECTED", hang: "TIMEOUT", late: "TIMEOUT", landed_hang: "TIMEOUT", badack: "ACK_INVALID", lostack: "ACK_INVALID" }[mode], mode);
    assert.equal(r.receiptLanding, "UNACKED_MAY_HAVE_LANDED", `${mode}: a started, unACKed receipt is never claimed absent`);
    assert.deepEqual(r.trustedHead, r.startAck, `${mode}: the trusted head stays at the LAST ACKED record`);
    assert.deepEqual([r.postcheck.intentState, r.postcheck.appliedEvents, r.postcheck.capture], ["capture_failed", 1, "pending:0:false:false"], `${mode}: recovery facts retained`);
    assert.equal(await state(a.id), "capture_failed", "the actual DB outcome stands (accepted abort)"); assert.equal(await appliedAborts(a.id), 1);
    if (mode === "late") assert.equal(jr.j.controls.release(8), true, "the late receipt lands AFTER the bridge stopped");
    const recs = (await jr.j.journal.read()).records;
    const landed = recs.at(-1).event === "ABORT_ACCEPTED";
    assert.equal(landed, mode !== "reject" && mode !== "hang", `${mode}: observed journal reality`);
    assert.equal(jr.j.controls.appendCalls(), 8, `${mode}: the receipt was never resent`);
    // the consumer boundary: ONLY the trusted head (last ACK) is authority
    const anchoredV = V2.validateJournalV2(recs, a.manifest, { trustedHead: r.trustedHead });
    const anchoredF = V2.journalFactsV2(recs, a.manifest, { trustedHead: r.trustedHead });
    const unanchored = V2.journalFactsV2(recs, a.manifest).facts;
    if (landed) {
      assert.deepEqual([anchoredV.ok, anchoredV.code, anchoredF.ok, anchoredF.code], [false, "TRUSTED_HEAD_MISMATCH", false, "TRUSTED_HEAD_MISMATCH"], `${mode}: the unACKed tail is refused`);
      assert.equal(unanchored.cleanupEntryPermitted, true, `${mode}: an UNANCHORED view would say 'permitted' — which is exactly why it is never authority`);
    } else {
      assert.deepEqual([anchoredV.ok, anchoredF.facts.abortStarted, anchoredF.facts.abortAccepted, anchoredF.facts.cleanupEntryPermitted], [true, true, false, false], mode);
    }
    // a second bridge call can never re-request: the journal is not abort-ready from the trusted head, whatever landed
    const again = await bridge(a, jr, { trustedHead: r.trustedHead, operatorDeps: counted(s) });
    assert.deepEqual([again.outcome, again.operatorCoreInvocations, s.n], ["REFUSED_BEFORE_START", 0, 1], mode);
    assert.equal(again.code, landed ? "JOURNAL_TRUSTED_HEAD_MISMATCH" : "JOURNAL_NOT_ABORT_READY", mode);
  }
});

test("B7 injected clock fault right BEFORE the receipt append, after a REAL applied abort: STOPPED_RECEIPT_UNACKED (append never started), no cleanup permission, recovery facts + start ACK retained, no top-level rejection", async () => {
  for (const how of ["throw", "nan"]) {
    const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 };
    const g = realGuard(); let k = 0;                                                            // now() calls: read 1, start 2, operator 3, postcheck 4, receipt 5
    const guard = { observe: g.observe, now: () => { k += 1; if (k !== 5) return g.now(); if (how === "throw") throw new Error("clock fault"); return { ok: true, value: NaN }; } };
    let r; await assert.doesNotReject(async () => { r = await bridge(a, jr, { guard, operatorDeps: counted(s) }); });
    assert.deepEqual([r.outcome, r.code, r.receiptLanding, r.cleanupPermitted, r.receiptAck, r.dbAbortApplied, r.operatorOutcome, s.n, k],
      ["STOPPED_RECEIPT_UNACKED", how === "throw" ? "GUARD_NOW_FAULT" : "GUARD_NOW_INVALID", "NOT_ATTEMPTED", false, null, true, "REQUESTED", 1, 5], how);
    assert.deepEqual(r.trustedHead, r.startAck); assert.equal(r.startAck.seq, jr.head.seq + 1);
    assert.equal(jr.j.controls.appendCalls(), 7, "the receipt append was never started");
    assert.deepEqual([r.postcheck.intentState, r.postcheck.appliedEvents, r.postcheck.claimHeld], ["capture_failed", 1, true]);
    assert.equal(await state(a.id), "capture_failed");
    const f = V2.journalFactsV2((await jr.j.journal.read()).records, a.manifest, { trustedHead: r.trustedHead }).facts;
    assert.deepEqual([f.abortStarted, f.abortAccepted, f.cleanupEntryPermitted], [true, false, false]);
  }
});

test("B8 abort ALREADY applied outside this ready journal handshake (SYNTHETIC outside actor = the accepted operator core) → NOT_EXECUTED_ALREADY_REQUESTED → ABORT_NOT_THIS_RUN: ZERO requestTestAbort calls, no receipt / adoption / cleanup, applied state preserved in diagnostics", async () => {
  const a = await confirmed("airbnb"); const jr = await reservedJournal(a); const s = { n: 0 };
  const outside = await executeOperatorAbort(db.app, a.e, { now: F.at(8), env: ENV });               // applied OUTSIDE the handshake (never journalled)
  assert.equal(outside.outcome, "REQUESTED"); assert.equal(await appliedAborts(a.id), 1);
  const r = await bridge(a, jr, { operatorDeps: counted(s) });
  assert.deepEqual([r.outcome, r.code, r.operatorOutcome, r.operatorCoreInvocations, r.requestHelperInvocations, s.n],
    ["ABORT_NOT_THIS_RUN", "ALREADY_REQUESTED_OUTSIDE_HANDSHAKE", "NOT_EXECUTED_ALREADY_REQUESTED", 1, 0, 0], JSON.stringify(r));
  assert.deepEqual([r.cleanupPermitted, r.receiptAck, r.receiptLanding, r.dbAbortApplied], [false, null, "NOT_ATTEMPTED", true], "applied: OBSERVED, not denied");
  assert.deepEqual([r.postcheck.appliedEvents, r.postcheck.appliedEventType, r.postcheck.intentState, r.postcheck.intentReason, r.postcheck.claimHeld],
    [1, "TEST_ABORT_REQUESTED", "capture_failed", "TEST_ABORT_REQUESTED", true]);
  assert.equal(await appliedAborts(a.id), 1, "nothing resent"); assert.equal(await state(a.id), "capture_failed");
  const recs = (await jr.j.journal.read()).records;
  assert.equal(recs.at(-1).event, "ABORT_REQUEST_STARTED", "no receipt was written");
  const f = V2.journalFactsV2(recs, a.manifest, { trustedHead: r.trustedHead }).facts;
  assert.deepEqual([f.abortStarted, f.abortAccepted, f.cleanupEntryPermitted], [true, false, false]);
  const again = await bridge(a, jr, { trustedHead: r.trustedHead, operatorDeps: counted(s) });
  assert.deepEqual([again.code, again.operatorCoreInvocations, s.n], ["JOURNAL_NOT_ABORT_READY", 0, 0]);
});

test("B9 DUPLICATE_RECONCILED race (distinct from B8): the abort is applied by a SYNTHETIC outside actor AFTER the core's precheck but before its ONE call → duplicate → ABORT_NOT_THIS_RUN; one counted call, no receipt / cleanup, applied state preserved", async () => {
  const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 }; const outside = { n: 0 };
  const racing = { requestTestAbort: async (...args) => { outside.n += 1; await requestTestAbort(...args); s.n += 1; return requestTestAbort(...args); } };
  const r = await bridge(a, jr, { operatorDeps: racing });
  assert.deepEqual([r.outcome, r.code, r.operatorOutcome, r.operatorCoreInvocations, r.requestHelperInvocations, s.n, outside.n],
    ["ABORT_NOT_THIS_RUN", "DUPLICATE_OUTSIDE_HANDSHAKE", "DUPLICATE_RECONCILED", 1, 1, 1, 1], JSON.stringify(r));
  assert.deepEqual([r.cleanupPermitted, r.receiptAck, r.dbAbortApplied, r.postcheck.appliedEvents, r.postcheck.intentState], [false, null, true, 1, "capture_failed"]);
  assert.equal(await appliedAborts(a.id), 1, "applied exactly once (the outside actor's)");
  assert.equal((await jr.j.journal.read()).records.at(-1).event, "ABORT_REQUEST_STARTED");
});

test("B6 a reply / flag alone is insufficient: a FABRICATED helper success (no DB change) and a conflicting open case planted after the reply (SYNTHETIC, owner) never yield a receipt", async () => {
  const a = await confirmed("disconnected"); const jr = await reservedJournal(a); const s = { n: 0 };
  const fake = { requestTestAbort: async () => { s.n += 1; return { ok: true }; } };            // claims success, writes nothing
  const r = await bridge(a, jr, { operatorDeps: fake });
  assert.deepEqual([r.outcome, r.operatorOutcome, r.cleanupPermitted, r.receiptAck, s.n], ["ABORT_OUTCOME_UNKNOWN", "POSTCHECK_MISMATCH", false, null, 1]);
  assert.equal(await state(a.id), "reservation_confirmed"); assert.equal(r.postcheck.appliedEvents, 0);
  // the abort really applies, but an open reconciliation case appears before the bridge's own postcheck (SYNTHETIC conflicting state)
  const b = await confirmed("airbnb"); const jb = await reservedJournal(b); const s2 = { n: 0 };
  const plant = { afterReply: async () => { await db.owner.query(`INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence)
    VALUES ($1, $2, 'SYNTHETIC_CONFLICT', 'open', now(), 'test', '{}'::jsonb)`, [randomUUID(), b.id]); } };
  const rb = await bridge(b, jb, { operatorDeps: counted(s2, plant) });
  assert.deepEqual([rb.outcome, rb.operatorOutcome, rb.code, rb.cleanupPermitted, rb.receiptAck, rb.postcheck.openCases, s2.n],
    ["ABORT_POSTCHECK_FAILED", "REQUESTED", "POSTCHECK_MISMATCH", false, null, 1, 1]);
  const f = V2.journalFactsV2((await jb.j.journal.read()).records, b.manifest).facts;
  assert.deepEqual([f.abortStarted, f.abortAccepted, f.cleanupEntryPermitted], [true, false, false]);
});
