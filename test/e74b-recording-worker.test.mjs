// Stage E7.4b — recording worker: pure gate / basis isolation / W-2 helper / bounded late observation (NO database, NO network).
// Every provider shape here is SYNTHETIC, DOC-DERIVED, LIVE-UNVERIFIED; 'credit_card' / 'other' are fixture values (no owner choice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordingWorkerGate, runRecordingStep, _internal, RECORDING_EXECUTOR_KEYS, ESCALATE_ALLOWLIST } from "../lib/booking-db/recording-worker.js";
import * as P from "../lib/checkout/offline-charge-proof.js";

const ENV = { VERCEL_ENV: "development", MV_E7_RECORDING_WORKER: "enabled" };
const cfg = (o = {}) => ({ accountRef: "acct-test-1", channelId: 2000, currency: "USD", listingId: 990001, paymentMethod: "credit_card", refFieldId: 777007, ...o });
const exec = (o = {}) => ({ label: { accountRef: "acct-test-1", clientSnapshotId: "client-A" }, retrieveReservation: async () => ({}), listOfflineCharges: async () => ({}),
  createOfflineCharge: async () => ({}), ...o });
const gate = (o = {}) => recordingWorkerGate({ env: ENV, listings: new Map([[990001, cfg()]]), executors: exec(), clock: () => 1, ...o });

test("gate: explicit test env + flag, USD, explicit approved paymentMethod (NO default), exact executor keys + label; both fixture methods accepted", () => {
  assert.equal(gate().ok, true);
  assert.equal(gate({ listings: new Map([[990001, cfg({ paymentMethod: "other" })]]) }).ok, true);
  const { paymentMethod, ...noMethod } = cfg();
  const cases = [
    [{ env: undefined }, "ENV_REQUIRED"], [{ env: { ...ENV, VERCEL_ENV: "production" } }, "PRODUCTION_REFUSED"], [{ env: { ...ENV, VERCEL_ENV: "staging" } }, "ENVIRONMENT_NOT_ALLOWED"],
    [{ env: { VERCEL_ENV: "preview" } }, "NOT_ENABLED"], [{ listings: new Map() }, "LISTINGS_REQUIRED"], [{ listings: { 990001: cfg() } }, "LISTINGS_REQUIRED"],
    [{ listings: new Map([[990001, noMethod]]) }, "PAYMENT_METHOD_UNSET"], [{ listings: new Map([[990001, cfg({ paymentMethod: null })]]) }, "PAYMENT_METHOD_UNSET"],
    [{ listings: new Map([[990001, cfg({ paymentMethod: "cash" })]]) }, "PAYMENT_METHOD_NOT_APPROVED"], [{ listings: new Map([[990001, cfg({ currency: "MXN" })]]) }, "CURRENCY_NOT_APPROVED"],
    [{ listings: new Map([[990002, cfg()]]) }, "LISTING_KEY_MISMATCH"], [{ executors: undefined }, "NO_EXECUTORS"],
    [{ executors: exec({ voidPaymentIntent: async () => {} }) }, "EXECUTOR_NOT_ALLOWED"], [{ executors: exec({ createOfflineCharge: "x" }) }, "NO_EXECUTORS"],
    [{ executors: exec({ label: undefined }) }, "LABEL_INVALID"], [{ executors: exec({ label: { accountRef: "acct-test-1", clientSnapshotId: "bad label!" } }) }, "LABEL_INVALID"],
    [{ executors: exec({ label: { accountRef: "acct-other", clientSnapshotId: "client-A" } }) }, "LABEL_ACCOUNT_MISMATCH"], [{ clock: undefined }, "CLOCK_REQUIRED"],
  ];
  for (const [o, code] of cases) assert.deepEqual(gate(o), { ok: false, code }, code);
  assert.deepEqual([...RECORDING_EXECUTOR_KEYS].sort(), ["createOfflineCharge", "listOfflineCharges", "retrieveReservation"], "no notify / refund / cancel / void executor");
  assert.equal(ESCALATE_ALLOWLIST.includes("PROTECTED_RESERVATION_ID"), false, "addendum A: protected is a local refusal");
});

test("addendum C: the basis is an isolated deep-frozen copy — later mutation of the caller's Map / cfg / executors / label cannot change it", () => {
  const c = cfg(); const listings = new Map([[990001, c]]); const ex = exec(); const create = ex.createOfflineCharge;
  const g = recordingWorkerGate({ env: ENV, listings, executors: ex, clock: () => 1 });
  c.paymentMethod = "other"; c.accountRef = "acct-x"; listings.set(990001, cfg({ paymentMethod: "other" })); listings.set(990009, cfg({ listingId: 990009 }));
  ex.createOfflineCharge = async () => "evil"; ex.label.accountRef = "acct-x";
  assert.equal(g.basis.cfgs["990001"].paymentMethod, "credit_card");
  assert.deepEqual(g.basis.listingIds, [990001]);
  assert.equal(g.basis.exec.createOfflineCharge, create);
  assert.equal(g.basis.label.accountRef, "acct-test-1");
  for (const o of [g.basis, g.basis.cfgs, g.basis.cfgs["990001"], g.basis.exec, g.basis.label, g.basis.listingIds]) assert.ok(Object.isFrozen(o));
  assert.equal(Object.values(g.basis).some((v) => v instanceof Map), false, "no Map (a frozen Map still allows set / delete)");
  assert.throws(() => { "use strict"; g.basis.cfgs["990002"] = {}; });
});

test("runRecordingStep: a refused gate / worker id issues NO query at all", async () => {
  let queried = 0;
  const trap = { query: async () => { queried += 1; throw new Error("no"); }, connect: async () => { queried += 1; throw new Error("no"); } };
  for (const o of [{ env: { VERCEL_ENV: "production" } }, { workerId: "bad id" }, { executors: exec({ refund: async () => {} }) }]) {
    const r = await runRecordingStep(trap, { workerId: "rw-1", env: ENV, listings: new Map([[990001, cfg()]]), executors: exec(), clock: () => 1, ...o });
    assert.equal(r.status, "refused"); assert.equal(r.writes, 0); assert.deepEqual(await r.late, { kind: "none" });
  }
  assert.equal(queried, 0);
});

// ---- W-2 helper ----
const INTENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = Date.UTC(2027, 0, 5, 13, 0, 0);
const intent = (o = {}) => ({ intentId: INTENT_ID, status: "payment_captured", version: 7, ref: "MV-ABC123", listingId: 990001, from: "2027-02-10", to: "2027-02-14",
  finalTotalMinor: 123456, capturedMinor: 123456, currency: "USD", reservationId: "88000001", recordedPaymentAt: NOW - 3600000, ...o });
const TITLE = `maraVilla payment mvoch1-${INTENT_ID}`;
const row = (o = {}) => ({ id: 501, listingMapId: 990001, reservationId: 88000001, type: "charge", title: "Accommodation payment", currency: "USD", paymentMethod: "credit_card",
  amount: 10, status: "paid", paymentProvider: "offline", ...o });
const list = (rows) => P.assessChargeList({ read: { accountRef: "acct-test-1", clientSnapshotId: "client-A", observedAt: NOW - 500, httpStatus: 200,
  request: { reservationId: "88000001", limit: 500 }, json: { status: "success", result: rows, count: rows.length } }, intent: intent(), config: cfg(), now: NOW });

test("W-2 preflightListObservation: branded input only, context-bound, canonical sorted ids, frozen (incl. ids); existing exports unchanged", () => {
  const l = list([row({ id: 900, title: TITLE }), row({ id: 77, title: TITLE }), row({ id: 600, title: `x ${TITLE}` }), row({ id: 601, amount: 1234.56 }), row({ id: 602 })]);
  const o = P.preflightListObservation({ list: l, intent: intent(), config: cfg() });
  assert.deepEqual(o, { clientSnapshotId: "client-A", complete: true, executorAccountRef: "acct-test-1", lookalikeCount: 1, matchingChargeCount: 2,
    matchingChargeIds: ["77", "900"], readCount: 1, requestLimit: 500, rowCount: 5, sameAmountPaidCount: 1 });
  assert.ok(Object.isFrozen(o) && Object.isFrozen(o.matchingChargeIds));
  assert.equal(P.preflightListObservation({ list: { ...l }, intent: intent(), config: cfg() }).code, "COMPLETE_LIST_REQUIRED", "a copy is not branded");
  assert.equal(P.preflightListObservation({ list: l, intent: intent({ version: 8 }), config: cfg() }).code, "LIST_CONTEXT_CHANGED");
  assert.equal(P.preflightListObservation({ list: l, intent: intent(), config: cfg({ paymentMethod: "other" }) }).code, "LIST_CONTEXT_CHANGED");
  assert.equal(P.preflightListObservation({ list: l, intent: intent({ currency: "MXN" }), config: cfg() }).code, "CURRENCY_MISMATCH");
  assert.deepEqual(P.preflightListObservation({ list: list([]), intent: intent(), config: cfg() }).matchingChargeIds, []);
  // the module stays pure (header test of e74b-offline-charge-proof still governs); no I/O tokens added
  const src = readFileSync(new URL("../lib/checkout/offline-charge-proof.js", import.meta.url), "utf8");
  for (const bad of ["Date.now", "new Date()", "process.env", "fetch(", "node:"]) assert.equal(src.includes(bad), false, bad);
});

// ---- addendum D ----
test("addendum D: late observation resolves within a finite window even if the raw promise NEVER settles; rejection handled; bounded fields; timer released", async () => {
  const ctx = { timeouts: { lateWindowMs: 30 } };
  const t0 = Date.now();
  assert.deepEqual(await _internal.observeLate(ctx, new Promise(() => {})), { kind: "none" });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(await _internal.observeLate(ctx, Promise.resolve({ httpStatus: 201, json: { secret: "x" } })), { kind: "late_reply", settled: "fulfilled", httpStatus: 201 });
  assert.deepEqual(await _internal.observeLate(ctx, Promise.resolve("weird")), { kind: "late_reply", settled: "fulfilled", httpStatus: null });
  let unhandled = 0; const h = () => { unhandled += 1; }; process.on("unhandledRejection", h);
  const rej = Promise.reject(new Error("late failure"));
  assert.deepEqual(await _internal.observeLate(ctx, rej), { kind: "late_reply", settled: "rejected", httpStatus: null });
  const later = new Promise((_, r) => setTimeout(() => r(new Error("after window")), 60));
  assert.deepEqual(await _internal.observeLate(ctx, later), { kind: "none" });
  await new Promise((r) => setTimeout(r, 80));
  process.off("unhandledRejection", h);
  assert.equal(unhandled, 0, "a rejection after the window is still handled");
  assert.deepEqual(await _internal.observeLate(ctx, null), { kind: "none" });
});

test("module boundaries: no provider client / env / dispatch / admin / drain / link import; never OFFLINE_CHARGE_FAILED", () => {
  const src = readFileSync(new URL("../lib/booking-db/recording-worker.js", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  for (const bad of ["process.env", "fetch(", "stripe", "hostaway.js\"", "dispatchOperation", "drainRecordingConflictInbox", "linkRecordingEvidence", "admin.js",
    "adminRelease", "OFFLINE_CHARGE_FAILED\"", "link_full_proof", "recordReleaseReviewAssessment"]) assert.equal(code.includes(bad), false, bad);
});

test("W-6 policy: escalate() refuses every non-allowlisted code locally with NO database call", async () => {
  let q = 0;
  const ctx = { actions: [], pool: { query: async () => { q += 1; }, connect: async () => { q += 1; } } };
  for (const code of ["CONFIG_SHAPE", "PROTECTED_RESERVATION_ID", "IDENTITY_STALE", "LABEL_INVALID", "CLOCK_SKEW", "NOT_PAYMENT_CAPTURED", "x"]) {
    const r = await _internal.escalate(ctx, { id: "0f8fad5b-d9cb-469f-a165-70867728950e", version: 1 }, code);
    assert.ok(r.delayMs > 0);
  }
  assert.equal(q, 0);
  assert.deepEqual(ctx.actions, ["STOP:CONFIG_SHAPE", "STOP:PROTECTED_RESERVATION_ID", "STOP:IDENTITY_STALE", "STOP:LABEL_INVALID", "STOP:CLOCK_SKEW", "STOP:NOT_PAYMENT_CAPTURED", "STOP:RECORDING_WORKER_CODE_INVALID"]);
});

// ---- root code review of ddda945 (R-C1 / R-C2) — FUNCTION-LEVEL controls with a STUB pool (no real database) ----
const stubPool = (fn) => { const s = { queries: 0, connects: 0 }; s.pool = { query: async (text, values) => { s.queries += 1; return fn(text, values, s.queries); },
  connect: async () => { s.connects += 1; throw new Error("no connect expected"); } }; return s; };
const goodStep = (pool, o = {}) => runRecordingStep(pool, { workerId: "rw-1", env: ENV, listings: new Map([[990001, cfg()]]), executors: exec(), clock: Date.now, ...o });

test("R-C1 (stub pool): a thrown connection / SQL error on the environment marker propagates as THE SAME object; exactly 1 query, 0 connects / writes / provider calls", async () => {
  for (const make of [() => Object.assign(new Error("connection terminated"), { code: "57P01" }),
    () => Object.assign(new Error('relation "booking.instance" does not exist'), { code: "42P01" }),
    () => Object.assign(new Error("ENVIRONMENT_MISMATCH: lookalike text in a transport error"), { code: "ECONNRESET" })]) {
    const err = make();
    let calls = 0; const ex = exec({ retrieveReservation: async () => { calls += 1; }, listOfflineCharges: async () => { calls += 1; }, createOfflineCharge: async () => { calls += 1; } });
    const s = stubPool(() => { throw err; });
    await assert.rejects(goodStep(s.pool, { executors: ex }), (e) => e === err && e.code === err.code && e.message === err.message);
    assert.deepEqual([s.queries, s.connects, calls], [1, 0, 0], err.code);
  }
});

test("R-C1 (stub pool): an ACKNOWLEDGED marker that is not 'test' (or absent) is the structured refusal DATABASE_NOT_TEST after exactly 1 query", async () => {
  for (const rows of [[{ environment: "live" }], [{ environment: "staging" }], []]) {
    const s = stubPool(() => ({ rows, rowCount: rows.length }));
    const r = await goodStep(s.pool);
    assert.deepEqual([r.status, r.code, r.writes, s.queries, s.connects], ["refused", "DATABASE_NOT_TEST", 0, 1, 0], JSON.stringify(rows));
  }
});

test("R-C2 (stub pool): selectRead — two OPEN candidates take precedence over a fresh uncited exhausted row: stop, after exactly the one candidacy query", async () => {
  const row = (o) => ({ id: "r", state: "pending", attempts: 1, max_attempts: 10, next_attempt_at: new Date(0), created_at: new Date(), fresh_escalated: false,
    has_evidence: false, cited: false, ...o });
  const rows = [row({ id: "exhausted", state: "escalated", attempts: 10, fresh_escalated: true }), row({ id: "p1" }), row({ id: "p2" })];
  const s = stubPool(() => ({ rows, rowCount: rows.length }));
  const ctx = { pool: s.pool, clock: Date.now, workerId: "rw-1" };
  assert.deepEqual(await _internal.selectRead(ctx, "op", "intent", "88000001", "hostaway.retrieve_reservation"), { kind: "stop", code: "READ_ROWS_AMBIGUOUS" });
  assert.deepEqual([s.queries, s.connects], [1, 0]);
  // controls: a single exhausted row (no open) is still cited; one exhausted + ONE open still cites the exhausted row (once-only count)
  for (const rs of [[rows[0]], [rows[0], rows[1]]]) {
    const t = stubPool(() => ({ rows: rs, rowCount: rs.length }));
    assert.deepEqual(await _internal.selectRead({ pool: t.pool, clock: Date.now, workerId: "rw-1" }, "op", "intent", "88000001", "hostaway.retrieve_reservation"),
      { kind: "cite", readId: "exhausted" });
    assert.equal(t.queries, 1);
  }
});
