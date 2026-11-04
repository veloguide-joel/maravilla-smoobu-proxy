// E7 connected-test runner SLICE D — in-memory journal + record / chain / start validation (OFFLINE UNIT; no DB, no network, no worker).
// SYNTHETIC: every identity, record, evidence reference and planted marker below is synthetic. The memory journal is NOT durable and
// proves nothing about files, fsync, atomicity or late appends; fake guard timers drive the observation-timeout cases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import * as J from "../scripts/e7-connected/run-journal-memory.mjs";
import { validateGuardDeps, createGuard, isNativePromise } from "../scripts/e7-connected/run-guard.mjs";
import { STATES } from "../lib/checkout/intent-state.js";
import { CHECKPOINTS } from "../scripts/e7-connected/run-manifest.mjs";

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

test("terminal rules: append after terminal and duplicate terminal refused; RUN_ENDED with an open step refused; RUN_STOPPED may close it only as outstanding STEP", async () => {
  const { journal } = mk();
  const recs = chain(HAPPY);
  for (const r of recs) await journal.append(r);
  const after = chain([...HAPPY, ["RUN_STOPPED"]]).at(-1);
  assert.equal(await codeOf(journal.append(after)), "APPEND_AFTER_TERMINAL");
  const afterStep = chain([...HAPPY, ["STEP_STARTED", "recording", 2]]).at(-1);
  assert.equal(await codeOf(journal.append(afterStep)), "APPEND_AFTER_TERMINAL");
  const open = [...HAPPY.slice(0, 3)];
  for (const [term, want] of [[["RUN_ENDED"], "ORDER_INVALID"], [["RUN_STOPPED", "TIMEOUT_STEP", { outstanding: "NONE" }], "ORDER_INVALID"], [["RUN_STOPPED", "TIMEOUT_STEP", { outstanding: "STEP" }], "RESOLVED"]]) {
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
  assert.deepEqual([...J.INTENT_STATES].sort(), Object.values(STATES).sort());
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
