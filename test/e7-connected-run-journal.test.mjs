// E7 connected-test runner SLICE D — in-memory journal + record / chain / start validation (OFFLINE UNIT; no DB, no network, no worker).
// SYNTHETIC: every identity, record, evidence reference and planted marker below is synthetic. The memory journal is NOT durable and
// proves nothing about files, fsync, atomicity or late appends; fake guard timers drive the observation-timeout cases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as J from "../scripts/e7-connected/run-journal-memory.mjs";
import { validateGuardDeps, createGuard, isNativePromise, createLifecycle, createLedger, wrapExecutors } from "../scripts/e7-connected/run-guard.mjs";
import { STATES } from "../lib/checkout/intent-state.js";
import { CHECKPOINTS, canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
// E7-0019 integration (ROOT 5879497019): v2 / R1 readers + the accepted R1 binder, used ONLY by the refusal test at the end of this file
import * as V2 from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";
import { R1_EXECUTOR_CLOSURE } from "../scripts/e7-connected/run-binding-r1.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../scripts/e7-connected/run-plan-v1.mjs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline journal suite)"); };
let unhandled = 0; const onU = () => { unhandled += 1; };
process.on("unhandledRejection", onU);
after(async () => { await new Promise((r) => setImmediate(r)); globalThis.fetch = realFetch; process.off("unhandledRejection", onU); assert.equal(netAttempts, 0); assert.equal(unhandled, 0, "no unhandled rejection"); });

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await null; };
const PENDING = Symbol("pending");
const stateOf = async (p) => Promise.race([p.then((x) => ({ x }), (e) => ({ e })), flush(40).then(() => PENDING)]);

const ID = Object.freeze({ runId: "synthetic-run-0001", intentId: "00000000-0000-4000-8000-0000000000c1", manifestHash: "a".repeat(64), baselineCommit: "0".repeat(40) });
/** INDEPENDENT canonical JSON (test-local; sorted keys) and hash */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const H = (r) => createHash("sha256").update(`e7-run-journal-v1\n${canon(r)}`, "utf8").digest("hex");
const W0 = { create: 0, capture: 0, record: 0, void: 0, cancel: 0 };
const bodies = {
  RUN_STARTED: () => ({}),
  ATTESTED: (checkpoint) => ({ attestation: { checkpoint, evidenceRef: `synthetic/${checkpoint.toLowerCase()}` } }),
  STEP_STARTED: (phase, step, factory = { phase, reservationId: null }) => ({ phase, step, factory }),
  STEP_ENDED: (phase, step, o = {}) => ({ phase, step, result: "worked", state: "reservation_pending", actions: ["RESERVATION_STARTED->reservation_pending"], unlistedActions: 0, refusals: [], writes: { ...W0 }, ...o }),
  PHASE_ENDED: (phase, state = "reservation_confirmed") => ({ phase, state }),
  RUN_STOPPED: (code = "TIMEOUT_STEP", o = {}) => ({ code, outstanding: "NONE", effectsKnown: false, exclusion: "held", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 }, ...o }),
  RUN_ENDED: (o = {}) => ({ outcome: "ENDED_CONFIRMED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: "confirmed", writes: { ...W0, create: 1, capture: 1, record: 1 }, ...o })
};
/** build a chain of [event, ...args] specs with seq / prevHash computed INDEPENDENTLY */
function chain(specs, id = ID) {
  const out = []; let prev = "0".repeat(64);
  for (const [i, [event, ...args]] of specs.entries()) {
    const r = { v: 1, seq: i + 1, prevHash: prev, ...id, at: 1_700_000_000_000 + i, event, ...bodies[event](...args) };
    out.push(r); prev = H(r);
  }
  return out;
}
const HAPPY = [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1],
  ["STEP_STARTED", "reservation", 2], ["STEP_ENDED", "reservation", 2, { state: "reservation_confirmed", actions: ["RESERVATION_SUCCEEDED->reservation_confirmed"], writes: { ...W0, create: 1 } }],
  ["PHASE_ENDED", "reservation"], ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "payment_captured", actions: ["CAPTURE_SUCCEEDED->payment_captured"] }],
  ["PHASE_ENDED", "capture", "payment_captured"], ["STEP_STARTED", "recording", 1], ["STEP_ENDED", "recording", 1, { state: "confirmed", actions: ["RECORDED->confirmed"] }],
  ["PHASE_ENDED", "recording", "confirmed"], ["RUN_ENDED"]];
const mk = (o = {}) => { const r = J.createMemoryJournal({ identity: ID, ...o }); assert.equal(r.ok, true, r.code); return r; };
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof J.JournalError); assert.deepEqual(Object.keys(e), ["name", "code"]); return e.code; } };
function fakeGuard() {
  const f = { t: 0, timers: [] };
  f.guard = createGuard(validateGuardDeps({ monotonic: () => f.t, timers: { arm: (ms) => { let res; const promise = new Promise((r) => { res = r; }); const e = { due: f.t + ms, res, live: true };
    f.timers.push(e); return { promise, cancel: () => { e.live = false; } }; } } }).deps);
  f.advance = async (ms) => { f.t += ms; for (const e of f.timers) if (e.live && e.due <= f.t) { e.live = false; e.res(undefined); } await flush(); };
  return f;
}

// =================================================================================================================================
test("happy chain: every append acknowledged with an INDEPENDENTLY recomputed head; read returns frozen copies; start → RUN_ENDED", async () => {
  const { journal, controls } = mk();
  const recs = chain(HAPPY);
  for (const r of recs) {
    const p = journal.append(r);
    assert.equal(isNativePromise(p), true, "an unpatched native promise (accepted run-guard rule)");
    assert.deepEqual({ ...(await p) }, { seq: r.seq, hash: H(r) });
  }
  assert.equal(controls.size(), recs.length);
  const rp = journal.read(); assert.equal(isNativePromise(rp), true);
  const rr = await rp;
  assert.ok(Object.isFrozen(rr) && Object.isFrozen(rr.records) && rr.records.every(Object.isFrozen));
  assert.equal(rr.tail, "complete");
  assert.deepEqual(rr.records.map((r) => canon(r)), recs.map((r) => canon(r)), "stored = the validated copies of the input");
  assert.equal(J.recordHash(rr.records.at(-1)), H(recs.at(-1)));
  const v = J.validateJournal(rr.records, ID);
  assert.deepEqual([v.ok, v.status, v.terminal, v.head.seq, v.head.hash, v.anchored], [true, "ENDED", "RUN_ENDED", recs.length, H(recs.at(-1)), false]);
  assert.deepEqual({ ...J.evaluateStart(rr, ID) }, { ok: false, code: "RUN_ENDED", anchored: false });
  assert.deepEqual({ ...J.evaluateStart(rr, ID, { trustedHead: { seq: recs.length, hash: H(recs.at(-1)) } }) }, { ok: false, code: "RUN_ENDED", anchored: true });
  assert.equal(J.GENESIS_HASH, "0".repeat(64)); assert.equal(J.JOURNAL_HASH_PREFIX, "e7-run-journal-v1\n");
});

test("caller mutation resistance: inputs and read results can never change stored history", async () => {
  const { journal } = mk();
  const recs = chain(HAPPY.slice(0, 4));
  for (const r of recs) await journal.append(r);
  recs[3].actions.push("STOP:X"); recs[3].writes.create = 9; recs[0].runId = "other-run-0001";
  const rr = await journal.read();
  assert.equal(rr.records[3].actions.length, 1); assert.equal(rr.records[3].writes.create, 0); assert.equal(rr.records[0].runId, ID.runId);
  assert.throws(() => { "use strict"; rr.records.push({}); });
  assert.throws(() => { "use strict"; rr.records[0].seq = 99; });
  assert.equal((await journal.read()).records.length, 4);
  assert.equal(J.validateJournal((await journal.read()).records, ID).ok, true);
});

test("append refusal categories — each leaves stored history untouched (no partial mutation)", async () => {
  const base = chain(HAPPY.slice(0, 3));
  const cases = [
    ["missing key", (r) => { delete r.at; }, "RECORD_INVALID"],
    ["extra key", (r) => { r.note = "x"; }, "RECORD_INVALID"],
    ["wrong version", (r) => { r.v = 2; }, "RECORD_INVALID"],
    ["bad action token", (r) => { r.actions = ["RESERVATION_STARTEDX"]; }, "ACTION_INVALID"],
    ["identity runId", (r) => { r.runId = "synthetic-run-0002"; }, "IDENTITY_MISMATCH"],
    ["identity manifestHash", (r) => { r.manifestHash = "b".repeat(64); }, "IDENTITY_MISMATCH"],
    ["seq skip", (r) => { r.seq = 5; }, "CHAIN_MISMATCH"],
    ["prevHash wrong", (r) => { r.prevHash = "1".repeat(64); }, "CHAIN_MISMATCH"],
    ["step out of order", (r) => { r.step = 2; }, "ORDER_INVALID"]
  ];
  for (const [name, mut, want] of cases) {
    const { journal, controls } = mk();
    for (const r of base) await journal.append(r);
    const next = chain([...HAPPY.slice(0, 3), ["STEP_ENDED", "reservation", 1]])[3];
    mut(next);
    assert.equal(await codeOf(journal.append(next)), want, name);
    assert.equal(controls.size(), 3, `${name}: history unchanged`);
    assert.equal(await codeOf(journal.append(chain([...HAPPY.slice(0, 3), ["STEP_ENDED", "reservation", 1]])[3])), "RESOLVED", `${name}: the correct record still appends`);
  }
  // order: STEP before CALENDAR_BASELINE, capture before AIRBNB_BLOCKED, double RUN_STARTED, phase skip
  for (const [name, specs] of [["step before baseline", [["RUN_STARTED"], ["STEP_STARTED", "reservation", 1]]], ["second RUN_STARTED", [["RUN_STARTED"], ["RUN_STARTED"]]],
    ["capture before AIRBNB_BLOCKED", [...HAPPY.slice(0, 7), ["STEP_STARTED", "capture", 1]]], ["recording right after reservation", [...HAPPY.slice(0, 8), ["STEP_STARTED", "recording", 1]]],
    ["REOPENED without cleanup", [...HAPPY.slice(0, 2), ["ATTESTED", "AIRBNB_REOPENED"]]], ["first event not RUN_STARTED", [["ATTESTED", "CALENDAR_BASELINE"]]]]) {
    const { journal, controls } = mk();
    const recs = chain(specs);
    for (const r of recs.slice(0, -1)) assert.equal(await codeOf(journal.append(r)), "RESOLVED", name);
    assert.equal(await codeOf(journal.append(recs.at(-1))), "ORDER_INVALID", name); assert.equal(controls.size(), recs.length - 1);
  }
});

test("terminal rules: append after terminal and duplicate terminal refused; RUN_ENDED with an open step refused; RUN_STOPPED closes it with the truthful status, never effectsKnown", async () => {
  const { journal } = mk();
  const recs = chain(HAPPY);
  for (const r of recs) await journal.append(r);
  const after = chain([...HAPPY, ["RUN_STOPPED"]]).at(-1);
  assert.equal(await codeOf(journal.append(after)), "APPEND_AFTER_TERMINAL");
  const afterStep = chain([...HAPPY, ["STEP_STARTED", "recording", 2]]).at(-1);
  assert.equal(await codeOf(journal.append(afterStep)), "APPEND_AFTER_TERMINAL");
  const open = [...HAPPY.slice(0, 3)];
  for (const [term, want] of [[["RUN_ENDED"], "ORDER_INVALID"], [["RUN_STOPPED", "DB_FAILURE", { outstanding: "NONE" }], "RESOLVED"],
    [["RUN_STOPPED", "DB_FAILURE", { outstanding: "TAIL" }], "RESOLVED"], [["RUN_STOPPED", "TIMEOUT_STEP", { outstanding: "STEP" }], "RESOLVED"],
    [["RUN_STOPPED", "DB_FAILURE", { outstanding: "NONE", effectsKnown: true }], "ORDER_INVALID"], [["RUN_STOPPED", "TIMEOUT_STEP", { outstanding: "STEP", effectsKnown: true }], "RECORD_INVALID"]]) {
    const j = mk().journal; const c = chain([...open, term]);
    for (const r of c.slice(0, -1)) await j.append(r);
    assert.equal(await codeOf(j.append(c.at(-1))), want, JSON.stringify(term));
  }
  assert.equal(J.validateJournal(chain([...HAPPY, ["RUN_STOPPED"]]), ID).code, "JOURNAL_MALFORMED", "duplicate terminal in a static history");
});

test("two concurrent appends can never reuse seq / prevHash: synchronous landing → CHAIN_MISMATCH; unacknowledged first → APPEND_IN_FLIGHT; no retry", async () => {
  { const { journal, controls } = mk();
    const recs = chain(HAPPY.slice(0, 2));
    await journal.append(recs[0]);
    const a = chain(HAPPY.slice(0, 2))[1]; const b = { ...chain(HAPPY.slice(0, 2))[1], at: a.at + 1 };
    const [pa, pb] = [journal.append(a), journal.append(b)];
    assert.deepEqual([await codeOf(pa), await codeOf(pb)], ["RESOLVED", "CHAIN_MISMATCH"]);
    assert.equal(controls.size(), 2); }
  { const { journal, controls } = mk({ faults: { append: { 2: "late" } } });
    const recs = chain(HAPPY.slice(0, 3));
    await journal.append(recs[0]);
    const p2 = journal.append(recs[1]);
    assert.equal(await stateOf(p2), PENDING);
    assert.equal(await codeOf(journal.append(recs[1])), "APPEND_IN_FLIGHT", "same record again");
    assert.equal(await codeOf(journal.append(recs[2])), "APPEND_IN_FLIGHT", "the next record");
    assert.equal(controls.size(), 1, "nothing landed yet");
    assert.equal(controls.release(2), true); assert.equal(controls.release(2), false);
    assert.equal((await p2).seq, 2);
    assert.equal(await codeOf(journal.append(recs[2])), "RESOLVED");
    assert.equal(controls.appendCalls(), 5, "every call counted; the journal itself never retried"); }
});

test("fault controls with the accepted guard: reject / hang / late / landed_hang — an observer's timeout never proves absence; no retry, no extra terminal", async () => {
  const recs = chain(HAPPY);
  // reject before acknowledgement: nothing stored
  { const { journal, controls } = mk({ faults: { append: { 1: "reject" } } });
    const g = fakeGuard();
    const r = await g.guard.observe(5_000, () => journal.append(recs[0]));
    assert.equal(r.kind, "rejected"); assert.deepEqual([r.reason.code, controls.size()], ["INJECTED_APPEND_FAILURE", 0]); }
  // hang: never lands, never settles; the observer times out; further appends refused
  { const { journal, controls } = mk({ faults: { append: { 2: "hang" } } });
    await journal.append(recs[0]);
    const g = fakeGuard();
    const p = g.guard.observe(5_000, () => journal.append(recs[1])); await flush(); await g.advance(5_000);
    assert.equal((await p).kind, "timeout"); assert.equal(controls.size(), 1);
    assert.equal(await codeOf(journal.append(recs[1])), "APPEND_IN_FLIGHT"); }
  // late: the observer times out, THEN the record lands + acknowledges under test control
  { const { journal, controls } = mk({ faults: { append: { 15: "late" } } });
    for (const r of recs.slice(0, 14)) await journal.append(r);
    const g = fakeGuard();
    const p = g.guard.observe(5_000, () => journal.append(recs[14])); await flush(); await g.advance(5_000);
    const r = await p; assert.equal(r.kind, "timeout");
    assert.deepEqual({ ...J.evaluateStart(await journal.read(), ID) }, { ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: false, anchored: false }, "not landed yet");
    controls.release(15); await flush();
    assert.deepEqual({ ...J.evaluateStart(await journal.read(), ID) }, { ok: false, code: "RUN_ENDED", anchored: false }, "landed late → RUN_ENDED; either way no worker");
    assert.equal(controls.size(), 15, "exactly one terminal — the journal never adds one"); }
  // landed_hang: stored immediately, never acknowledged → observer timeout while the record IS present
  { const { journal, controls } = mk({ faults: { append: { 1: "landed_hang" } } });
    const g = fakeGuard();
    const p = g.guard.observe(5_000, () => journal.append(recs[0])); await flush(); await g.advance(5_000);
    assert.equal((await p).kind, "timeout"); assert.equal(controls.size(), 1, "the observer cannot tell landed from absent");
    assert.equal(await codeOf(journal.append(recs[1])), "APPEND_IN_FLIGHT"); }
  // read faults
  { const { journal } = mk({ faults: { read: { 1: "reject", 2: "hang", 3: "torn" } } });
    assert.equal(await codeOf(journal.read()), "INJECTED_READ_FAILURE");
    const g = fakeGuard(); const p = g.guard.observe(5_000, () => journal.read()); await flush(); await g.advance(5_000);
    assert.equal((await p).kind, "timeout");
    assert.deepEqual({ ...J.evaluateStart(await journal.read(), ID) }, { ok: false, code: "JOURNAL_PARTIAL" }, "SYNTHETIC torn-tail representation");
    assert.equal((await journal.read()).tail, "complete"); }
});

test("start verdicts: empty is NOT authorization (DB check still required); interrupted STEP_STARTED → RESTART_AMBIGUOUS (crash evidence, never resume)", async () => {
  const empty = await mk().journal.read();
  assert.deepEqual({ ...J.evaluateStart(empty, ID) }, { ok: true, code: "EMPTY_JOURNAL", dbEligibilityRequired: true, anchored: false });
  const started = chain(HAPPY.slice(0, 1));
  assert.deepEqual({ ...J.evaluateStart({ records: started, tail: "complete" }, ID) }, { ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: false, anchored: false });
  const interrupted = chain(HAPPY.slice(0, 3));
  assert.deepEqual({ ...J.evaluateStart({ records: interrupted, tail: "complete" }, ID) }, { ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: true, anchored: false });
  const stopped = chain([...HAPPY.slice(0, 3), ["RUN_STOPPED", "TIMEOUT_STEP", { outstanding: "STEP" }]]);
  assert.equal(J.evaluateStart({ records: stopped, tail: "complete" }, ID).code, "RUN_ENDED");
  for (const bad of [null, [], { records: [] }, { records: [], tail: "x" }, { records: [], tail: "complete", extra: 1 }, new Proxy({ records: [], tail: "complete" }, {})]) {
    assert.equal(J.evaluateStart(bad, ID).code, "READ_RESULT_INVALID");
  }
  // the module exposes no resume / run-id / key minting surface
  assert.deepEqual(Object.keys(J).filter((k) => /resume|mint|(new|next)Run|IdempotencyKey|nextKey/i.test(k)), []);
});

test("identity mismatch per field and chain / seq edits", () => {
  const recs = chain(HAPPY);
  for (const k of J.IDENTITY_KEYS) {
    const other = { ...ID, [k]: k === "intentId" ? "00000000-0000-4000-8000-0000000000c2" : k === "runId" ? "synthetic-run-0009" : k === "manifestHash" ? "b".repeat(64) : "1".repeat(40) };
    assert.equal(J.validateJournal(recs, other).code, "MANIFEST_MISMATCH", `expected identity differs in ${k}`);
    const foreign = chain(HAPPY, other);
    assert.equal(J.evaluateStart({ records: [...recs.slice(0, 3), foreign[3]], tail: "complete" }, ID).code, "MANIFEST_MISMATCH", `one foreign record (${k})`);
  }
  const edited = recs.map((r) => ({ ...r })); edited[4].at += 1;                    // content edit, hash not recomputed
  assert.deepEqual({ ...J.validateJournal(edited, ID) }, { ok: false, code: "JOURNAL_CHAIN_INVALID", at: 6 });
  const gap = recs.filter((_, i) => i !== 5);
  assert.equal(J.validateJournal(gap, ID).code, "JOURNAL_CHAIN_INVALID");
  const swapped = [...recs]; [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  assert.equal(J.validateJournal(swapped, ID).code, "JOURNAL_CHAIN_INVALID");
  assert.equal(J.validateJournal(recs.slice(1), ID).code, "JOURNAL_CHAIN_INVALID", "dropping the first record");
  assert.equal(J.validateJournal([{ ...recs[0], prevHash: "f".repeat(64) }], ID).code, "JOURNAL_CHAIN_INVALID", "genesis prevHash");
  assert.equal(J.validateJournal(recs, { ...ID, extra: 1 }).code, "IDENTITY_INVALID");
});

test("complete rewrite: an UNANCHORED consistent forgery validates (documented limit); a trusted head detects rewrite / truncation / deletion", () => {
  const real = chain(HAPPY);
  const realHead = { seq: real.length, hash: H(real.at(-1)) };
  const forged = chain([...HAPPY.slice(0, 6), ["PHASE_ENDED", "reservation"], ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "capture", 1],
    ["STEP_ENDED", "capture", 1, { state: "payment_captured" }], ["PHASE_ENDED", "capture", "payment_captured"], ["STEP_STARTED", "recording", 1],
    ["STEP_ENDED", "recording", 1, { state: "confirmed", writes: { ...W0, record: 1 } }], ["PHASE_ENDED", "recording", "confirmed"], ["RUN_ENDED", { writes: { ...W0 } }]]);
  const fv = J.validateJournal(forged, ID);
  assert.deepEqual([fv.ok, fv.status, fv.anchored], [true, "ENDED", false], "a whole-history rewrite is internally consistent: the chain alone cannot detect it");
  assert.notEqual(fv.head.hash, realHead.hash);
  assert.deepEqual({ ...J.validateJournal(forged, ID, { trustedHead: realHead }) }, { ok: false, code: "TRUSTED_HEAD_MISMATCH" });
  assert.equal(J.validateJournal(real, ID, { trustedHead: realHead }).anchored, true);
  assert.equal(J.validateJournal(real.slice(0, -1), ID, { trustedHead: realHead }).code, "TRUSTED_HEAD_MISMATCH", "truncation (terminal dropped)");
  assert.equal(J.evaluateStart({ records: real.slice(0, -1), tail: "complete" }, ID).code, "RESTART_AMBIGUOUS", "unanchored truncation is still never a start");
  assert.equal(J.validateJournal([], ID, { trustedHead: realHead }).code, "TRUSTED_HEAD_MISMATCH", "deleted history");
  assert.equal(J.evaluateStart({ records: [], tail: "complete" }, ID, { trustedHead: { seq: 0, hash: "0".repeat(64) } }).code, "EMPTY_JOURNAL");
  for (const bad of [{ trustedHead: { seq: -1, hash: "0".repeat(64) } }, { trustedHead: { seq: 1 } }, { trustedHead: { seq: 1, hash: "X" } }, { other: 1 }]) {
    assert.equal(J.validateJournal(real, ID, bad).code, "TRUSTED_HEAD_INVALID");
  }
});

test("hostile descriptor inputs: refused without running getters / iterators / toJSON; frozen and null-prototype controls accepted", async () => {
  let runs = 0;
  const good = () => chain(HAPPY.slice(0, 1))[0];
  const hostile = [
    Object.defineProperty(good(), "at", { enumerable: true, get() { runs += 1; return 1; } }),
    (() => { const r = good(); r[Symbol("s")] = 1; return r; })(),
    Object.defineProperty(good(), "hidden", { value: 1, enumerable: false }),
    Object.defineProperty(good(), "__proto__", { value: {}, enumerable: true }),
    (() => { const r = good(); r.toJSON = () => { runs += 1; return {}; }; return r; })(),
    new Proxy(good(), {}), (() => { const p = Proxy.revocable(good(), {}); p.revoke(); return p.proxy; })(),
    new Proxy(good(), { ownKeys() { runs += 1; throw new Error("CALLER_DATA"); } }),
    Object.assign(Object.create({ inherited: 1 }), good()), new (class R { constructor() { Object.assign(this, good()); } })(),
    { ...good(), seq: 1.5 }, { ...good(), at: NaN }, { ...good(), prevHash: new String("0".repeat(64)) }
  ];
  const step = chain(HAPPY.slice(0, 4))[3];
  const hostileStep = [
    { ...step, actions: (() => { const a = [...step.actions]; a[Symbol.iterator] = function* () { runs += 1; yield "x"; }; return a; })() },
    { ...step, actions: ["RESERVATION_STARTED->reservation_pending", , "WAIT:X"] },          // eslint-disable-line no-sparse-arrays
    { ...step, writes: Object.defineProperty({ ...W0 }, "create", { enumerable: true, get() { runs += 1; return 0; } }) }
  ];
  for (const h of hostile) { const { journal, controls } = mk(); assert.ok(["RECORD_INVALID"].includes(await codeOf(journal.append(h)))); assert.equal(controls.size(), 0); }
  for (const h of hostileStep) {
    const { journal, controls } = mk(); for (const r of chain(HAPPY.slice(0, 3))) await journal.append(r);
    assert.equal(await codeOf(journal.append(h)), "RECORD_INVALID"); assert.equal(controls.size(), 3);
  }
  for (const h of [...hostile, ...hostileStep]) { assert.equal(J.validateRecord(h).ok, false); }
  assert.equal(J.validateJournal(new Proxy(chain(HAPPY), {}), ID).code, "JOURNAL_MALFORMED");
  assert.equal(J.validateIdentity(Object.defineProperty({ ...ID }, "runId", { enumerable: true, get() { runs += 1; return ID.runId; } })).ok, false);
  assert.equal(J.createMemoryJournal(new Proxy({ identity: ID }, {})).ok, false);
  assert.equal(runs, 0, "no caller getter / iterator / toJSON / trap ran");
  // controls: deep-frozen and null-prototype records
  const df = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") df(v); return Object.freeze(o); };
  const nul = (o) => Object.assign(Object.create(null), o);
  const { journal } = mk();
  assert.equal(await codeOf(journal.append(df(good()))), "RESOLVED");
  const r2 = chain(HAPPY.slice(0, 2))[1];
  assert.equal(await codeOf(journal.append(nul({ ...r2, attestation: nul(r2.attestation) }))), "RESOLVED");
  assert.equal(J.validateIdentity(nul({ ...ID })).ok, true);
});

test("redaction: planted SYNTHETIC markers in actions are counted, never copied; free-form / contact-shaped fields refused; documented grammar limit", async () => {
  const MARKERS = ["SYNTHETIC-SECRET-MARKER-7f3a", "guest.marker@example.test", '{"raw":"provider reply"}', "Bearer SYNTHETIC-TOKEN-SHAPED-MARKER", "STOP:has space", "READ:hostaway.retrieve_reservation:error:extra", "RESERVATION_STARTED->not_a_state"];
  const raw = ["RESERVATION_STARTED->reservation_pending", ...MARKERS, "WAIT:CREATE_PENDING"];
  const p = J.projectActions(raw);
  assert.deepEqual([[...p.actions], p.unlistedActions], [["RESERVATION_STARTED->reservation_pending", "WAIT:CREATE_PENDING"], MARKERS.length]);
  const { journal } = mk(); for (const r of chain(HAPPY.slice(0, 3))) await journal.append(r);
  const step = chain([...HAPPY.slice(0, 3), ["STEP_ENDED", "reservation", 1, { actions: [...p.actions], unlistedActions: p.unlistedActions }]])[3];
  assert.equal(await codeOf(journal.append(step)), "RESOLVED");
  const json = JSON.stringify((await journal.read()).records);
  for (const m of MARKERS) assert.ok(!json.includes(m), `marker never copied: ${m}`);
  for (const [field, v] of [["evidenceRef", "has space"], ["evidenceRef", "guest@example.test"], ["evidenceRef", "x".repeat(129)]]) {
    const r = chain([...HAPPY.slice(0, 1), ["ATTESTED", "CALENDAR_BASELINE"]])[1]; r.attestation[field] = v;
    assert.equal(J.validateRecord(r).ok, false, `${field} = ${v}`);
  }
  const rf = chain(HAPPY.slice(0, 4))[3];
  for (const bad of [[{ key: "lookupPage", code: "lowercase" }], [{ key: "a b", code: "X" }], [{ key: "lookupPage", code: "X", message: "m" }]]) assert.equal(J.validateRecord({ ...rf, refusals: bad }).ok, false);
  assert.equal(J.validateRecord({ ...rf, refusals: [{ key: "pricing.get", code: "RESERVATION_UNBOUND" }] }).ok, true);
  // LIMIT (documented): the grammar bounds characters, it cannot prove an allowed reference holds no secret
  const lim = chain([...HAPPY.slice(0, 1), ["ATTESTED", "CALENDAR_BASELINE"]])[1]; lim.attestation.evidenceRef = "SYNTHETICMARKERNOTASECRET";
  assert.equal(J.validateRecord(lim).ok, true);
  assert.deepEqual({ ...J.projectActions(new Proxy([], {})) }, { ok: false, code: "ACTIONS_INVALID" });
});

test("grammar pinned against the accepted worker sources; vocabulary parity with intent-state / migrations / planner / manifest", () => {
  const dir = new URL("../lib/booking-db/", import.meta.url);
  const literals = new Set();
  for (const f of readdirSync(dir).filter((x) => /-worker\.js$|^recovery\.js$/.test(x))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    // whole-token literals only: template substitutions (${…}) are removed first, so fragments like "ID" inside `READ:${…}` are not tokens
    for (const m of src.matchAll(/actions\.push\(([^;]*)\)/g)) for (const s of m[1].replace(/\$\{[^}]*\}/g, "").matchAll(/"([A-Z][A-Za-z0-9_:.>-]*)"/g)) literals.add(s[1]);
  }
  assert.ok(literals.size >= 30, String(literals.size));
  for (const t of literals) assert.equal(J.isActionToken(t), true, `worker literal accepted: ${t}`);
  // representative TEMPLATED forms, built exactly as the workers build them
  for (const t of ["RESERVATION_STARTED->reservation_pending", "RESERVATION_STARTED!E3_REJECTED", "CAPTURE_SUCCEEDED->payment_captured", "RECORDED:DUPLICATE",
    "ASSESSED:eligible", "ASSESSED:blocked:HOLD_ACTIVE", "WAIT:CAPTURE_IN_FLIGHT", "STOP:RECORDING_ESCALATED", "LEASE_LOST:WORK_LEASE_LOST", "READ:hostaway.lookup_reservation:found",
    "READ:ID:OK", "READ:LIST:TRANSPORT_TIMEOUT:succeeded", "READ:ID:TRANSPORT_ERROR!LEASE_LOST", "READ:PI!TRANSPORT", "RECOVERY:READ:hostaway.retrieve_reservation",
    "RECOVERY:RECONCILED_RESERVATION_FOUND", "RECOVERY:RESERVATION_OUTCOME_UNKNOWN!E3_DUPLICATE", "RECOVERY:ESCALATE:RESERVATION_ID_CONFLICT", "RECOVERY:REISSUE",
    "MAINTENANCE:hostaway.create_reservation:outcome_unknown", "SEND_ABORTED:STEP_BUDGET"]) assert.equal(J.isActionToken(t), true, t);
  for (const t of ["", "RESERVATION_STARTEDX", "XRESERVATION_STARTED", "RESERVATION_STARTED->bogus", "READ:hostaway.unknown_op", "MAINTENANCE:guest.notify:done",
    "STOP:A:B:C:D", "RECOVERY:NOT_AN_EVENT", "WAIT:" + "A".repeat(49), "stop:x", "WAIT:A B", `RECOVERY:READ:${"x".repeat(150)}`]) assert.equal(J.isActionToken(t), false, `refused: ${t}`);
  // E7-0019 (ROOT 5879497019): the frozen v1/v2/R1 journal vocabulary is BYTE-IDENTICAL; lib/checkout/intent-state.js grew exactly ONE state
  // (STATES.TEST_CLEANUP_PENDING) that the journals do not know. EXPLICIT singleton exclusion, both directions — no wildcard, no pattern.
  assert.equal(STATES.TEST_CLEANUP_PENDING, "test_cleanup_pending", "the constant exists with its pinned value");
  const e3States = Object.values(STATES), jStates = [...J.INTENT_STATES];
  assert.deepEqual(e3States.filter((s) => !jStates.includes(s)), [STATES.TEST_CLEANUP_PENDING], "intent-state minus journal = exactly the singleton");
  assert.deepEqual(jStates.filter((s) => !e3States.includes(s)), [], "journal minus intent-state = empty");
  assert.deepEqual(jStates.sort(), e3States.filter((s) => s !== STATES.TEST_CLEANUP_PENDING).sort());
  assert.equal(jStates.length, 20); assert.equal(e3States.length, 21);
  const sql1 = readFileSync(new URL("../db/migrations/0001_booking_core.up.sql", import.meta.url), "utf8");
  for (const s of J.INTENT_STATES) assert.ok(sql1.includes(`'${s}'`), s);
  for (const s of J.OPERATION_STATES) assert.ok(/state IN \('pending', 'in_flight', 'succeeded', 'failed_definite',\s+'outcome_unknown', 'superseded', 'escalated'\)/.test(sql1) && sql1.includes(`'${s}'`));
  const sql3 = readFileSync(new URL("../db/migrations/0003_safety_corrections.up.sql", import.meta.url), "utf8");
  const opCheck = /external_operations_op_type_check CHECK \(op_type IN \(([^;]*?)\)\);/s.exec(sql3)[1];
  assert.deepEqual([...opCheck.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]).sort(), [...J.OPERATION_TYPES].sort());
  const plan = readFileSync(new URL("../lib/checkout/recovery-plan.js", import.meta.url), "utf8");
  for (const m of plan.matchAll(/ev\("([A-Z_]+)"/g)) assert.ok(J.RECOVERY_EVENTS.includes(m[1]), `planner event ${m[1]}`);
  assert.deepEqual([...CHECKPOINTS], ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"]);
});

test("purity: no timer / env / fs / network / SDK / worker / pinned identifiers; exact import list", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-journal-memory.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/setTimeout|setInterval|setImmediate|queueMicrotask/, /process\./, /\bfetch\s*\(/, /node:(fs|net|https?|child_process|timers)/, /Date\.now|performance\.now/,
    /hostaway-reservations|connectedTestAdapterConfig|allowRequest:|booking-db|-worker/]) assert.doesNotMatch(code, re, String(re));
  assert.deepEqual([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort(), ["./run-manifest.mjs", "node:crypto", "node:util"]);
});

test("journal options validation and code-only errors", async () => {
  for (const bad of [null, {}, { identity: { ...ID, runId: "BAD" } }, { identity: ID, other: 1 }, { identity: ID, faults: { append: { 0: "reject" } } }, { identity: ID, faults: { append: { 1: "explode" } } },
    { identity: ID, faults: { write: {} } }, { identity: ID, preload: "x" }]) assert.equal(J.createMemoryJournal(bad).ok, false);
  const { journal } = mk({ preload: chain(HAPPY.slice(0, 2)).map((r, i) => (i === 1 ? { ...r, prevHash: "1".repeat(64) } : r)) });
  assert.equal(J.evaluateStart(await journal.read(), ID).code, "JOURNAL_CHAIN_INVALID", "SYNTHETIC preload of a broken history");
  assert.equal(await codeOf(journal.append(chain(HAPPY.slice(0, 3))[2])), "JOURNAL_HISTORY_INVALID", "no append onto an invalid stored history");
  const e = new J.JournalError("X"); assert.equal(e.message, "JOURNAL_ERROR"); assert.ok(Object.isFrozen(e));
});

// =================================================================================================================================
// Root CODE HOLD on 6cdb8ae0 — R-D1 (truthful failure stop from an OPEN logged step) / R-D2 (structural success / release paths)
const STOP_BODY = (outstanding) => ({ code: "DB_FAILURE", outstanding, effectsKnown: false, exclusion: "held", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0 } });
async function openStepJournal() {
  const { journal, controls } = mk();
  for (const r of chain(HAPPY.slice(0, 3))) await journal.append(r);        // RUN_STARTED, CALENDAR_BASELINE, STEP_STARTED reservation/1
  return { journal, controls };
}
const stopRecord = (outstanding, code = "DB_FAILURE") => chain([...HAPPY.slice(0, 3), ["RUN_STOPPED", code, STOP_BODY(outstanding)]])[3];

test("R-D1 with the ACCEPTED guard + lifecycle: the logged step's truthful status (NONE / TAIL unobservable / STEP) is the stop's outstanding value; no STEP_ENDED is invented, nothing awaited", async () => {
  // (a) rejection BEFORE any executor start → outstanding NONE
  { const { journal } = await openStepJournal(); const f = fakeGuard(); const lc = createLifecycle({ guard: f.guard }); const ledger = createLedger();
    const r = await lc.observeStep({ phase: "reservation", deadline: 75_000, ledger, start: () => Promise.reject(new Error("synthetic DB error")) });
    assert.deepEqual([r.kind, r.outstanding, ledger.snapshot().started], ["rejected", "NONE", 0]);
    const s = lc.snapshot();
    assert.equal(await codeOf(journal.append(stopRecord(s.outstanding))), "RESOLVED");
    assert.deepEqual({ ...J.evaluateStart(await journal.read(), ID) }, { ok: false, code: "RUN_ENDED", anchored: false }); }
  // (b) rejection AFTER ≥ 1 executor start → outstanding TAIL (unobservable); the tail is NOT awaited
  { const { journal } = await openStepJournal(); const f = fakeGuard(); const lc = createLifecycle({ guard: f.guard }); const ledger = createLedger();
    const w = wrapExecutors({ createReservation: () => new Promise(() => {}) }, ledger);
    const r = await lc.observeStep({ phase: "reservation", deadline: 75_000, ledger, start: () => { w.executors.createReservation({}); return Promise.reject(new Error("synthetic DB error")); } });
    const s = lc.snapshot();
    assert.deepEqual([r.kind, s.outstanding, s.tailObservable, ledger.snapshot().started], ["rejected", "TAIL", false, 1]);
    assert.equal(await codeOf(journal.append(stopRecord(s.outstanding))), "RESOLVED");
    assert.equal(await stateOf(lc.finalize()), PENDING, "the unobservable tail is never awaited or fabricated as complete");
    assert.equal(J.evaluateStart(await journal.read(), ID).code, "RUN_ENDED"); }
  // (c) observation TIMEOUT → outstanding STEP
  { const { journal } = await openStepJournal(); const f = fakeGuard(); const lc = createLifecycle({ guard: f.guard }); const ledger = createLedger();
    const p = lc.observeStep({ phase: "reservation", deadline: 75_000, ledger, start: () => new Promise(() => {}) }); await flush(); await f.advance(75_000);
    const r = await p;
    assert.deepEqual([r.kind, r.outstanding], ["timeout", "STEP"]);
    assert.equal(await codeOf(journal.append(stopRecord(lc.snapshot().outstanding, "TIMEOUT_STEP"))), "RESOLVED"); }
  // effects are never claimed known from an open step, and outstanding work always means effects unknown
  { const { journal, controls } = await openStepJournal();
    const known = chain([...HAPPY.slice(0, 3), ["RUN_STOPPED", "DB_FAILURE", { ...STOP_BODY("NONE"), effectsKnown: true }]])[3];
    assert.equal(await codeOf(journal.append(known)), "ORDER_INVALID"); assert.equal(controls.size(), 3, "history unchanged");
    for (const o of ["STEP", "TAIL"]) assert.equal(J.validateRecord({ ...stopRecord(o), effectsKnown: true }).ok, false); }
});

// structurally coherent success / release paths
const RES_OK = [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1, { state: "reservation_confirmed" }],
  ["PHASE_ENDED", "reservation", "reservation_confirmed"]];
const CAP_OK = [...RES_OK, ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "payment_captured" }], ["PHASE_ENDED", "capture", "payment_captured"]];
const ENDED = (outcome, key, o = {}) => ["RUN_ENDED", { outcome, ownerCleanupRequired: key, ...o }];
const CLEAN = (state) => [["STEP_STARTED", "cleanup", 1], ["STEP_ENDED", "cleanup", 1, { state }], ["PHASE_ENDED", "cleanup", state]];
const RES_FAIL = [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1, { state: "reservation_failed" }],
  ["PHASE_ENDED", "reservation", "reservation_failed"]];
const CAP_FAIL = [...RES_OK, ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "capture_failed" }], ["PHASE_ENDED", "capture", "capture_failed"]];
const verdict = (specs) => { const v = J.validateJournal(chain(specs), ID); return v.ok ? `ok:${v.status}` : v.code; };

test("R-D2: every successful terminal needs its completed phase, end state, checkpoint and EXACT cleanup key; released paths by reservation existence", () => {
  const ok = [
    ["reserved, not captured", [...RES_OK, ["ATTESTED", "AIRBNB_BLOCKED"], ENDED("ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed")]],
    ["captured, not recorded", [...CAP_OK, ENDED("ENDED_CAPTURED_NOT_RECORDED", "captured")]],
    ["confirmed (HAPPY)", HAPPY],
    ["released: reservation failed → void only", [...RES_FAIL, ...CLEAN("authorization_released"), ENDED("ENDED_RELEASED", null)]],
    ["released: capture failed → reservation cancelled, Airbnb re-opened", [...CAP_FAIL, ...CLEAN("cancelled"), ["ATTESTED", "AIRBNB_REOPENED"], ENDED("ENDED_RELEASED", null)]],
    ["released: capture failed → authorization released, reservation still standing", [...CAP_FAIL, ...CLEAN("authorization_released"), ENDED("ENDED_RELEASED", "reservedNotConfirmed")]]
  ];
  for (const [name, specs] of ok) assert.equal(verdict(specs), "ok:ENDED", name);
  const bad = [
    ["RUN_STARTED → RUN_ENDED (root probe)", [["RUN_STARTED"], ENDED("ENDED_CONFIRMED", "confirmed")]],
    ["confirmed without recording", [...CAP_OK, ENDED("ENDED_CONFIRMED", "confirmed")]],
    ["reserved-not-captured without AIRBNB_BLOCKED", [...RES_OK, ENDED("ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed")]],
    ["reserved-not-captured after a capture phase", [...CAP_OK, ENDED("ENDED_RESERVED_NOT_CAPTURED", "reservedNotConfirmed")]],
    ["captured-not-recorded with capture failed", [...CAP_FAIL, ENDED("ENDED_CAPTURED_NOT_RECORDED", "captured")]],
    ["ended with the last phase not ended", [...RES_OK, ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "payment_captured" }], ENDED("ENDED_CAPTURED_NOT_RECORDED", "captured")]],
    ["released after reservation failed with a standing-reservation key", [...RES_FAIL, ...CLEAN("authorization_released"), ENDED("ENDED_RELEASED", "reservedNotConfirmed")]],
    ["released by cancel without AIRBNB_REOPENED", [...CAP_FAIL, ...CLEAN("cancelled"), ENDED("ENDED_RELEASED", null)]],
    ["reservation still standing but key null", [...CAP_FAIL, ...CLEAN("authorization_released"), ENDED("ENDED_RELEASED", null)]],
    ["AIRBNB_REOPENED when no reservation existed", [...RES_FAIL, ...CLEAN("authorization_released"), ["ATTESTED", "AIRBNB_REOPENED"]]],
    ["cancel when no reservation existed (cleanup cannot end cancelled path)", [...RES_FAIL, ...CLEAN("cancelled"), ENDED("ENDED_RELEASED", null)]],
    ["capture after reservation FAILED", [...RES_FAIL, ["STEP_STARTED", "capture", 1]]],
    ["cleanup after reservation CONFIRMED", [...RES_OK, ["ATTESTED", "AIRBNB_BLOCKED"], ["STEP_STARTED", "cleanup", 1]]],
    ["AIRBNB_BLOCKED after reservation failed", [...RES_FAIL, ["ATTESTED", "AIRBNB_BLOCKED"]]],
    ["PHASE_ENDED state ≠ the last completed step", [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1, { state: "reservation_pending" }], ["PHASE_ENDED", "reservation", "reservation_confirmed"]]],
    ["PHASE_ENDED in a non-terminal state", [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1, { state: "reservation_pending" }], ["PHASE_ENDED", "reservation", "reservation_pending"]]],
    ["PHASE_ENDED without a completed step", [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["RUN_STOPPED", "DB_FAILURE", STOP_BODY("STEP")], ["PHASE_ENDED", "reservation", "reservation_confirmed"]]]
  ];
  for (const [name, specs] of bad) assert.ok(["JOURNAL_MALFORMED"].includes(verdict(specs)), `${name}: ${verdict(specs)}`);
  // exact cleanup key per outcome is a FIELD rule
  for (const [outcome, wrong] of [["ENDED_CONFIRMED", null], ["ENDED_CONFIRMED", "captured"], ["ENDED_CAPTURED_NOT_RECORDED", "confirmed"], ["ENDED_RESERVED_NOT_CAPTURED", null], ["ENDED_RELEASED", "confirmed"]]) {
    assert.equal(J.validateRecord(chain([["RUN_STARTED"], ENDED(outcome, wrong)])[1]).ok, false, `${outcome} with ${wrong}`);
  }
});

test("R-D2 through the journal: a structurally incoherent terminal is refused at append time and history stays unchanged", async () => {
  const { journal, controls } = mk();
  const recs = chain([...CAP_OK, ENDED("ENDED_CONFIRMED", "confirmed")]);
  for (const r of recs.slice(0, -1)) await journal.append(r);
  assert.equal(await codeOf(journal.append(recs.at(-1))), "ORDER_INVALID");
  assert.equal(controls.size(), recs.length - 1);
  const good = chain([...CAP_OK, ENDED("ENDED_CAPTURED_NOT_RECORDED", "captured")]).at(-1);
  assert.equal(await codeOf(journal.append(good)), "RESOLVED");
  assert.equal(J.evaluateStart(await journal.read(), ID).code, "RUN_ENDED");
  const bare = mk(); await bare.journal.append(chain([["RUN_STARTED"]])[0]);
  assert.equal(await codeOf(bare.journal.append(chain([["RUN_STARTED"], ENDED("ENDED_CONFIRMED", "confirmed")])[1])), "ORDER_INVALID", "root probe through append");
  assert.equal(bare.controls.size(), 1);
});

// =================================================================================================================================
// E7-0019 integration (ROOT 5879497019): the v1 / v2 / R1 journal READERS and VALIDATORS still REFUSE the new intent state and every
// refund-only action / op type / recovery event. OFFLINE; the R1 binding below is minted from a LABELLED COPY of the accepted G1/G2b
// synthetic fixture (test/e7-connected-run-journal-r1-g2b.test.mjs:22–60) against the CURRENT repo sources (no network, no DB).
test("E7-0019: v1 / v2 / R1 journals REFUSE test_cleanup_pending and refund-only vocabulary (frozen grammar, singleton exclusion)", () => {
  const TCP = STATES.TEST_CLEANUP_PENDING;
  // vocabulary: none of the refund-only tokens leaked into the frozen lists
  assert.ok(!J.INTENT_STATES.includes(TCP));
  for (const op of ["stripe.refund_payment_intent", "stripe.retrieve_refund"]) assert.ok(!J.OPERATION_TYPES.includes(op), op);
  for (const ev of ["TEST_CLEANUP_REQUESTED", "REFUND_SUCCEEDED", "REFUND_OUTCOME_UNKNOWN", "REFUND_FAILED"]) { assert.ok(!J.RECOVERY_EVENTS.includes(ev), ev); assert.ok(!J.ACTION_NAMES.includes(ev), ev); }
  assert.ok(!J.ACTION_NAMES.includes("REFUND_CLAIMED"));
  // v1 action grammar: every refund-only / cleanup-state token is refused; the frozen neighbours stay accepted (control)
  for (const t of [`TEST_CLEANUP_REQUESTED->${TCP}`, `REFUND_SUCCEEDED->${TCP}`, `RESERVATION_CANCELLED->${TCP}`, `CANCEL_CLAIMED->${TCP}`, "REFUND_CLAIMED", "REFUND_SUCCEEDED",
    "RECOVERY:REFUND_SUCCEEDED", "RECOVERY:REFUND_OUTCOME_UNKNOWN", "RECOVERY:TEST_CLEANUP_REQUESTED", "RECOVERY:READ:stripe.retrieve_refund",
    "MAINTENANCE:stripe.refund_payment_intent:outcome_unknown", "MAINTENANCE:stripe.retrieve_refund:succeeded", "READ:stripe.retrieve_refund:found",
    "READ:stripe.retrieve_refund:not_found", "RECOVERY:ESCALATE:RESERVATION_STILL_ACTIVE_AFTER_CANCEL->" + TCP]) assert.equal(J.isActionToken(t), false, `refused: ${t}`);
  for (const t of ["RESERVATION_CANCELLED->cancelled", "CANCEL_CLAIMED", "RECOVERY:RESERVATION_CANCELLED", "MAINTENANCE:stripe.void_payment_intent:outcome_unknown"]) assert.equal(J.isActionToken(t), true, t);
  // v1 record validator: STEP_ENDED / PHASE_ENDED carrying the new state are RECORD_FIELD_INVALID (controls with a frozen state pass)
  const v1 = chain(HAPPY.slice(0, 7));
  const v1Step = v1[3], v1Phase = v1[6];
  assert.equal(J.validateRecord(v1Step).ok, true); assert.equal(J.validateRecord(v1Phase).ok, true);
  assert.deepEqual(J.validateRecord({ ...v1Step, state: TCP }), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(J.validateRecord({ ...v1Step, phase: "cleanup", state: TCP, actions: ["CANCEL_CLAIMED"] }), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(J.validateRecord({ ...v1Phase, phase: "cleanup", state: TCP }), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.equal(J.validateRecord({ ...v1Phase, phase: "cleanup", state: "cancelled" }).ok, true, "control: frozen cleanup end state");
  assert.deepEqual(J.validateRecord({ ...v1Step, phase: "cleanup", state: "cancelled", actions: [`TEST_CLEANUP_REQUESTED->${TCP}`] }), { ok: false, code: "ACTION_INVALID" });
  assert.deepEqual(J.validateRecord({ ...v1Step, phase: "cleanup", state: "cancelled", actions: ["READ:stripe.retrieve_refund:found"] }), { ok: false, code: "ACTION_INVALID" });
  // v2 reader (manifest-bound): same refusal, identity-correct control passes
  const m2 = { version: "e7-run-manifest-v2", runId: "synthetic-run-v2-0019", intentId: "00000000-0000-4000-8000-0000000000c2", baselineCommit: "0".repeat(40),
    synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" }, listing: { id: 891001, currency: "USD", refFieldId: 777009, timeZone: "America/Mazatlan", connection: "disconnected" },
    expectedRef: "MV-SYNTH19", stay: { arrival: "2026-12-04", departure: "2026-12-06", guests: 2 }, amountMinor: 50000, pricing: { rateBps: 1000 },
    stripeAccountId: "acct_1SyntheticRunner", hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" },
    phases: { capture: true, recording: true, testAbortAfterReservation: false }, paymentMethod: "credit_card",
    cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
    automationsReviewed: "synthetic/automations", checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"] };
  const vm = validateRunManifestV2(m2); assert.equal(vm.ok, true, vm.code);
  const id2 = { manifestVersion: "e7-run-manifest-v2", connection: "disconnected", runId: m2.runId, intentId: m2.intentId, baselineCommit: m2.baselineCommit, manifestHash: vm.hash };
  const v2Step = { v: 2, seq: 4, prevHash: "1".repeat(64), ...id2, at: 1_700_000_000_003, event: "STEP_ENDED", ...bodies.STEP_ENDED("reservation", 1) };
  const v2Phase = { v: 2, seq: 7, prevHash: "1".repeat(64), ...id2, at: 1_700_000_000_006, event: "PHASE_ENDED", ...bodies.PHASE_ENDED("reservation") };
  assert.equal(V2.validateRecordV2(v2Step, m2).ok, true, "control"); assert.equal(V2.validateRecordV2(v2Phase, m2).ok, true, "control");
  assert.deepEqual(V2.validateRecordV2({ ...v2Step, state: TCP }, m2), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(V2.validateRecordV2({ ...v2Phase, phase: "cleanup", state: TCP }, m2), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(V2.validateRecordV2({ ...v2Step, actions: [`REFUND_SUCCEEDED->${TCP}`] }, m2), { ok: false, code: "ACTION_INVALID" });
  const b2 = V2.bindManifestV2(m2); assert.equal(b2.ok, true);
  assert.deepEqual(V2.validateRecordBound({ ...v2Step, state: TCP }, b2.binding), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(V2.journalFactsV2([{ ...v2Step, seq: 1, prevHash: J.GENESIS_HASH, state: TCP }], m2).ok, false, "v2 facts reader refuses");
  // R1 reader (package-bound; LABELLED COPY of the accepted G1/G2b synthetic fixture): same refusal, control passes
  const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
  const enc = new TextEncoder(); const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
  const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) })); const EXEC = R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
  const NOW = Date.parse("2027-02-01T03:00:00.000Z"); const MIN = 60_000; const at = (ms) => new Date(NOW - ms).toISOString();
  const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
    present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
      "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) });
  const plan = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-r1-0019", createdAt: at(MIN),
    baseline: { repoCommit: "58a88f691ac88dcb260cdf407a73785cd96949cd", sourceDigest: sourceDigestV1(FOUND) },
    environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"],
    deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 }, stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)),
    binding: { intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "MV-SYN0019", paymentIntentId: "pi_SYNTHETIC0000f1",
      stay: { arrival: "2027-03-10", departure: "2027-03-12", guests: 2 }, amountMinor: 23000, rateBps: 1000,
      quote: { totalMinor: 23000, currency: "USD", quotedAt: at(10 * MIN) }, authorizedAt: at(5 * MIN) } };
  const planBytes = enc.encode(`${canonicalJson(plan)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV(), planClock: NOW }); assert.ok(built.ok, `fixture build ${built.code}`);
  const execDigest = createHash("sha256").update(Buffer.concat([Buffer.from("e7-run-executor-source-r1\n"), ...EXEC.flatMap((e) => [Buffer.from(`${e.path}\0${e.bytes.length}\0`), Buffer.from(e.bytes), Buffer.from([0])])])).digest("hex");
  const mr = V2.bindRunPackageR1Journal({ packageBytes: enc.encode(`${canonicalJson(built.package)}\n`), planBytes, foundationSources: FOUND, executorSources: EXEC, envSnapshot: ENV(),
    expected: { packageHash: built.packageHash, executorDigest: execDigest } }, NOW);
  assert.equal(mr.ok, true, JSON.stringify(mr)); const b1 = mr.binding; assert.equal(V2.bindingKindV2(b1), "r1");
  const r1Step = { v: 2, seq: 4, prevHash: "1".repeat(64), ...b1.identity, at: NOW, event: "STEP_ENDED", ...bodies.STEP_ENDED("reservation", 1) };
  const r1Phase = { v: 2, seq: 7, prevHash: "1".repeat(64), ...b1.identity, at: NOW, event: "PHASE_ENDED", ...bodies.PHASE_ENDED("reservation") };
  assert.equal(V2.validateRecordBound(r1Step, b1).ok, true, "control"); assert.equal(V2.validateRecordBound(r1Phase, b1).ok, true, "control");
  assert.deepEqual(V2.validateRecordBound({ ...r1Step, state: TCP }, b1), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(V2.validateRecordBound({ ...r1Phase, phase: "cleanup", state: TCP }, b1), { ok: false, code: "RECORD_FIELD_INVALID" });
  assert.deepEqual(V2.validateRecordBound({ ...r1Step, actions: ["MAINTENANCE:stripe.refund_payment_intent:outcome_unknown"] }, b1), { ok: false, code: "ACTION_INVALID" });
  assert.equal(V2.journalFactsBound([{ ...r1Step, seq: 1, prevHash: J.GENESIS_HASH, state: TCP }], b1).ok, false, "R1 facts reader refuses");
  // the v2 module takes its state vocabulary FROM v1 (one frozen list; no second copy to drift)
  const v2src = readFileSync(new URL("../scripts/e7-connected/run-journal-memory-v2.mjs", import.meta.url), "utf8");
  assert.ok(/import \{ INTENT_STATES,[^}]*\} from "\.\/run-journal-memory\.mjs"/.test(v2src)); assert.ok(!v2src.includes(TCP) && !v2src.includes("refund"));
});
