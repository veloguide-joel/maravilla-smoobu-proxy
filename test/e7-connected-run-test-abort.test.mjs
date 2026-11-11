// E7 M2-C — journalled TEST-abort handshake: PURE journal acceptance / refusal + bridge boundaries WITHOUT a database.
// SYNTHETIC values only. The pool here is a COUNTING FAKE that must never be called; the abort helper is never reached in this file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as V2 from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import { runTestAbortBridge, BRIDGE_OUTCOMES } from "../scripts/e7-connected/run-test-abort.mjs";
import { validateGuardDeps, createGuard } from "../scripts/e7-connected/run-guard.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";
import { buildAbortExpectation } from "../scripts/e7-operator/test-abort.mjs";

let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
after(async () => { await new Promise((r) => setImmediate(r)); process.off("unhandledRejection", onU); assert.equal(unhandled, 0); });
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await null; };

const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };
const INTENT = "00000000-0000-4000-8000-0000000000d1"; const PI = "pi_ABRTsynthetic01"; const RID = "61000123";
const ABORT_PH = { capture: false, recording: false, testAbortAfterReservation: true };
const manifest = (connection = "disconnected", phases = ABORT_PH, over = {}) => ({
  version: "e7-run-manifest-v2", runId: "synthetic-run-m2c-0001", intentId: INTENT, baselineCommit: "0".repeat(40), synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" },
  listing: { id: 606998, currency: "USD", refFieldId: 777011, timeZone: "America/Mazatlan", connection }, expectedRef: "MV-SYNTH0C",
  stay: { arrival: "2027-02-06", departure: "2027-02-09", guests: 2 }, amountMinor: 69000, pricing: { rateBps: 1000 }, stripeAccountId: "acct_1SyntheticRunner",
  hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" }, phases, paymentMethod: phases.recording ? "credit_card" : null,
  cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
  automationsReviewed: "synthetic/automations", checkpoints: [...CK[connection]], ...over });
const OPFIELDS = { intentId: INTENT, expectedVersion: 9, listingId: 606998, from: "2027-02-06", to: "2027-02-09", guests: 2, currency: "USD", finalTotalMinor: 69000,
  authorizedMinor: 69000, paymentIntentId: PI, sessionId: "cs_test_abortSynth01", attemptId: "00000000-0000-4000-8000-0000000000d2", reservationId: RID, approvalRef: "synthetic-m2c" };
const operator = (over = {}) => { const e = buildAbortExpectation({ ...OPFIELDS, ...over }); assert.ok(e); return { ...e }; };
const idOf = (m) => ({ manifestVersion: "e7-run-manifest-v2", connection: m.listing.connection, runId: m.runId, intentId: m.intentId, baselineCommit: m.baselineCommit,
  manifestHash: validateRunManifestV2(m).hash });
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const H2 = (r) => createHash("sha256").update(`e7-run-journal-v2\n${canon(r)}`, "utf8").digest("hex");
const W0 = { create: 0, capture: 0, record: 0, void: 0, cancel: 0 };
const ABORT = (o = {}) => ({ eventId: `test-abort:${INTENT}:${PI}:${RID}`, planHash: operator().planHash, expectedVersion: 9, paymentIntentId: PI, reservationId: RID, ...o });
const RECEIPT = (o = {}) => ({ appliedVersion: 10, state: "capture_failed", reason: "TEST_ABORT_REQUESTED", capture: { state: "pending", attempts: 0, dispatched: false },
  queued: ["alert.owner:pending", "hostaway.cancel_reservation:pending", "stripe.void_payment_intent:pending"], claimHeld: true, ...o });
const bodies = {
  RUN_STARTED: () => ({}), ATTESTED: (c) => ({ attestation: { checkpoint: c, evidenceRef: `synthetic/${c.toLowerCase()}` } }),
  STEP_STARTED: (phase, step) => ({ phase, step, factory: { phase, reservationId: null } }),
  STEP_ENDED: (phase, step, o = {}) => ({ phase, step, result: "worked", state: "reservation_pending", actions: ["RESERVATION_STARTED->reservation_pending"], unlistedActions: 0, refusals: [], writes: { ...W0 }, ...o }),
  PHASE_ENDED: (phase, state = "reservation_confirmed") => ({ phase, state }),
  ABORT_REQUEST_STARTED: (o) => ({ abort: ABORT(o) }), ABORT_ACCEPTED: (o, r) => ({ abort: ABORT(o), receipt: RECEIPT(r) }),
  RUN_STOPPED: (code = "ABORT_OUTCOME_UNKNOWN", o = {}) => ({ code, outstanding: "NONE", effectsKnown: false, exclusion: "held", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 }, ...o }),
  RUN_ENDED: (o = {}) => ({ outcome: "ENDED_RELEASED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 }, ...o })
};
function chain(specs, id) { const out = []; let prev = "0".repeat(64); for (const [i, [ev, ...a]] of specs.entries()) { const r = { v: 2, seq: i + 1, prevHash: prev, ...id, at: 1_700_000_000_000 + i, event: ev, ...bodies[ev](...a) }; out.push(r); prev = H2(r); } return out; }
const RESERVED = (c) => [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1],
  ["STEP_ENDED", "reservation", 1, { state: "reservation_confirmed", actions: ["RESERVATION_SUCCEEDED->reservation_confirmed"], writes: { ...W0, create: 1 } }],
  ["PHASE_ENDED", "reservation"], ["ATTESTED", CK[c][1]]];
const CLEANUP = (c) => [["STEP_STARTED", "cleanup", 1], ["STEP_ENDED", "cleanup", 1, { state: "cancelled", actions: ["VOID_SUCCEEDED", "RESERVATION_CANCELLED->cancelled"], writes: { ...W0, void: 1, cancel: 1 } }],
  ["PHASE_ENDED", "cleanup", "cancelled"], ["ATTESTED", CK[c][2]], ["RUN_ENDED"]];
const FULL = (c) => [...RESERVED(c), ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ...CLEANUP(c)];
const v = (specs, m) => V2.validateJournalV2(chain(specs, idOf(m)), m);

test("H1 handshake acceptance in BOTH modes: reserved → blocked → ABORT_REQUEST_STARTED → ABORT_ACCEPTED → cleanup (cancelled) → mode REOPENED → ENDED_RELEASED; facts track every stage", () => {
  for (const c of ["disconnected", "airbnb"]) {
    const m = manifest(c); const recs = chain(FULL(c), idOf(m));
    const r = V2.validateJournalV2(recs, m); assert.equal(r.ok, true, `${c} ${r.code} ${r.at}`); assert.equal(r.status, "ENDED");
    const at = (n) => V2.journalFactsV2(recs.slice(0, n), m).facts;
    assert.deepEqual([at(6).abortReady, at(6).abortStarted, at(6).cleanupEntryPermitted], [true, false, false]);
    assert.deepEqual([at(7).abortReady, at(7).abortStarted, at(7).abortAccepted, at(7).cleanupEntryPermitted], [false, true, false, false]);
    assert.deepEqual([at(8).abortAccepted, at(8).cleanupEntryPermitted], [true, true]);
    // a stop between the two records is allowed (uncertain outcome) and is terminal
    assert.equal(v([...RESERVED(c), ["ABORT_REQUEST_STARTED"], ["RUN_STOPPED"]], m).status, "ENDED");
    // an old valid chain WITHOUT abort records validates exactly as before (reservation-only honest end)
    assert.equal(v([...RESERVED(c), ["RUN_ENDED", { outcome: "ENDED_RESERVED_NOT_CAPTURED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]], m).ok, true);
  }
});

test("H2 refusals: unplanned / early / duplicate / mismatched / forged-receipt / cross-mode / identity / version; no cleanup or release without a receipt", () => {
  const c = "disconnected"; const m = manifest(c); const R = RESERVED(c);
  const code = (specs, mm = m) => v(specs, mm).code;
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"]], manifest(c, { capture: false, recording: false, testAbortAfterReservation: false })), "PHASE_NOT_PLANNED");
  assert.equal(code([...R.slice(0, 5), ["ABORT_REQUEST_STARTED"]]), "JOURNAL_MALFORMED", "before the blocked attestation");
  assert.equal(code([...R.slice(0, 3), ["ABORT_REQUEST_STARTED"]]), "JOURNAL_MALFORMED", "with an open step");
  assert.equal(code([...R, ["ABORT_ACCEPTED"]]), "JOURNAL_MALFORMED", "receipt without start");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_REQUEST_STARTED"]]), "JOURNAL_MALFORMED", "duplicate start");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ["ABORT_ACCEPTED"]]), "JOURNAL_MALFORMED", "duplicate receipt");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED", { expectedVersion: 8, }, { appliedVersion: 9 }]]), "JOURNAL_MALFORMED", "stale receipt for another version");
  for (const [o, r, what] of [[{ eventId: `test-abort:${INTENT}:${PI}:61000999` }, {}, "event id not deterministic"], [{}, { appliedVersion: 11 }, "applied ≠ expected+1"],
    [{}, { state: "cancelled" }, "state"], [{}, { reason: "AUTHORIZATION_EXPIRED" }, "reason"], [{}, { claimHeld: false }, "claim"],
    [{}, { capture: { state: "in_flight", attempts: 1, dispatched: true } }, "capture dispatched"], [{}, { capture: { state: "pending", attempts: 0, dispatched: true } }, "capture dispatched flag"],
    [{}, { queued: ["alert.owner:pending", "stripe.void_payment_intent:pending"] }, "missing obligation"],
    [{}, { queued: ["alert.owner:pending", "stripe.void_payment_intent:pending", "hostaway.cancel_reservation:pending"] }, "reordered obligations"],
    [{ planHash: "z" }, {}, "plan hash"], [{ paymentIntentId: "pi_x" }, {}, "pi"]]) {
    assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED", o, r]]), "JOURNAL_MALFORMED", what);
  }
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED", { planHash: "f".repeat(64) }]]), "JOURNAL_MALFORMED", "receipt for a different started abort");
  // nothing else between start and receipt; no cleanup / release without the receipt
  for (const mid of [["STEP_STARTED", "cleanup", 1], ["ATTESTED", CK[c][2]], ["RUN_ENDED"], ["RUN_ENDED", { outcome: "ENDED_RESERVED_NOT_CAPTURED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]]) {
    assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], mid]), "JOURNAL_MALFORMED", JSON.stringify(mid));
  }
  assert.equal(code([...R, ["STEP_STARTED", "cleanup", 1]]), "JOURNAL_MALFORMED", "the flag alone never permits cleanup");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ["RUN_ENDED", { outcome: "ENDED_RESERVED_NOT_CAPTURED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]]),
    "JOURNAL_MALFORMED", "after an accepted abort, 'reserved not captured' is not true any more");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ["RUN_ENDED"]]), "JOURNAL_MALFORMED", "released without cleanup");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ...CLEANUP(c).slice(0, 3), ["RUN_ENDED"]]), "JOURNAL_MALFORMED", "released without the mode reopened");
  assert.equal(code([...R, ["ABORT_REQUEST_STARTED"], ["ABORT_ACCEPTED"], ["STEP_STARTED", "cleanup", 1], ["STEP_ENDED", "cleanup", 1, { state: "reconciliation_required", actions: ["VOID_CLAIMED"] }],
    ["PHASE_ENDED", "cleanup", "reconciliation_required"]]), "JOURNAL_MALFORMED", "an unknown leg can never END the cleanup phase");
  assert.equal(code([...FULL(c).slice(0, 11), ["ATTESTED", CK.airbnb[2]], ["RUN_ENDED"]]), "CHECKPOINT_MODE_MISMATCH", "cross-mode reopened");
  assert.equal(v(FULL("airbnb"), manifest("airbnb")).ok, true);
  assert.equal(V2.validateJournalV2(chain(R, { ...idOf(m), intentId: "00000000-0000-4000-8000-0000000000d9" }), m).code, "MANIFEST_MISMATCH", "identity");
  // abort records bind the event id to the record's OWN intent id: a forged identity makes them field-invalid even before the identity check
  assert.equal(V2.validateJournalV2(chain(FULL(c), { ...idOf(m), intentId: "00000000-0000-4000-8000-0000000000d9" }), m).code, "JOURNAL_MALFORMED", "forged identity on abort records");
  const forgedEvent = chain(FULL(c), idOf(m)).map((r) => (r.event === "ABORT_ACCEPTED" ? { ...r, v: 1 } : r));
  assert.equal(V2.validateJournalV2(forgedEvent, m).code, "JOURNAL_MALFORMED", "version");
  assert.equal(V2.validateJournalV2(chain(FULL(c), idOf(m)).map((r) => (r.event === "ABORT_ACCEPTED" ? { ...r, event: "ABORT_ACCEPTED_X" } : r)), m).code, "JOURNAL_MALFORMED", "event");
});

// ---- bridge boundaries without a database ------------------------------------------------------------------------------------
function realGuard() { return createGuard(validateGuardDeps({ monotonic: () => performance.now(), timers: { arm: (ms) => { let h; const promise = new Promise((r) => { h = setTimeout(r, ms); }); return { promise, cancel: () => clearTimeout(h) }; } } }).deps); }
function fakeGuard() {
  const f = { t: 0, timers: [] };
  f.guard = createGuard(validateGuardDeps({ monotonic: () => f.t, timers: { arm: (ms) => { let res; const promise = new Promise((r) => { res = r; }); const e = { due: f.t + ms, res, live: true };
    f.timers.push(e); return { promise, cancel: () => { e.live = false; } }; } } }).deps);
  f.advance = async (ms) => { f.t += ms; for (const e of f.timers) if (e.live && e.due <= f.t) { e.live = false; e.res(undefined); } await flush(); };
  return f;
}
const countingPool = () => { const p = { calls: 0, query() { p.calls += 1; return Promise.reject(new Error("no DB in this file")); }, connect() { p.calls += 1; return Promise.reject(new Error("no DB")); } }; return p; };
const ENV = { VERCEL_ENV: "development", MV_E7_TEST_ABORT: "enabled" };
async function readyJournal(c = "disconnected", opts = {}) {
  const m = manifest(c); const recs = chain(RESERVED(c), idOf(m));
  const j = V2.createMemoryJournalV2({ manifest: m, ...opts }); assert.equal(j.ok, true, j.code);
  let head; for (const r of recs) head = await j.journal.append(r);
  return { m, j, head: { ...head }, n: recs.length };
}
const spyDeps = (s) => ({ requestTestAbort: async () => { s.n += 1; throw new Error("helper must not be reached in this file"); } });

test("H3 bridge refusals BEFORE the start record: input / manifest / operator binding / capabilities / trusted head / journal readiness — 0 pool calls, 0 helper calls, nothing appended", async () => {
  const { m, j, head, n } = await readyJournal();
  const base = () => ({ manifest: m, operator: operator(), journal: j.journal, trustedHead: head, pool: countingPool(), env: ENV, guard: realGuard(), now: 1_800_000_000_000 });
  const s = { n: 0 };
  const cases = [
    ["extra key", { ...base(), extra: 1 }, "INPUT_INVALID"], ["missing env", (() => { const x = base(); delete x.env; return x; })(), "INPUT_INVALID"],
    ["proxy input", new Proxy(base(), {}), "INPUT_INVALID"],
    ["non-abort manifest", { ...base(), manifest: manifest("disconnected", { capture: false, recording: false, testAbortAfterReservation: false }) }, "MANIFEST_NOT_ABORT_PLAN"],
    ["capture plan", { ...base(), manifest: manifest("disconnected", { capture: true, recording: false, testAbortAfterReservation: false }) }, "MANIFEST_NOT_ABORT_PLAN"],
    ["proxy manifest", { ...base(), manifest: new Proxy(manifest(), {}) }, "MANIFEST_INVALID"],
    ["operator plan hash", { ...base(), operator: { ...operator(), planHash: "0".repeat(64) } }, "OPERATOR_EXPECTATION_INVALID"],
    ["operator boxed", { ...base(), operator: { ...operator(), paymentIntentId: [PI] } }, "OPERATOR_EXPECTATION_INVALID"],
    ...[["intentId", "00000000-0000-4000-8000-0000000000d9"], ["from", "2027-02-05"], ["to", "2027-02-10"], ["guests", 3], ["finalTotalMinor", 69001]]
      .map(([k, val]) => [`operator ${k}`, { ...base(), operator: operator({ [k]: val, ...(k === "finalTotalMinor" ? { authorizedMinor: val } : {}) }) }, "OPERATOR_MANIFEST_MISMATCH"]),
    ["journal capability", { ...base(), journal: { append: () => 0 } }, "CAPABILITY_INVALID"], ["guard capability", { ...base(), guard: {} }, "CAPABILITY_INVALID"],
    ["trusted head shape", { ...base(), trustedHead: { seq: 0, hash: head.hash } }, "TRUSTED_HEAD_INVALID"],
    ["trusted head mismatch", { ...base(), trustedHead: { seq: head.seq, hash: "e".repeat(64) } }, "JOURNAL_TRUSTED_HEAD_MISMATCH"],
    ["env boxed", { ...base(), env: { VERCEL_ENV: new String("development") } }, "ENV_INVALID"], ["clock", { ...base(), now: "now" }, "CLOCK_INVALID"]
  ];
  for (const [label, inp, want] of cases) {
    const r = await runTestAbortBridge(inp);
    assert.equal(r.outcome, "REFUSED_BEFORE_START", label); assert.equal(r.code, want, label);
    assert.deepEqual([r.operatorCoreInvocations, r.cleanupPermitted, r.startAck], [0, false, null], label);
    if (inp.pool && inp.pool.calls !== undefined) assert.equal(inp.pool.calls, 0, label);
  }
  assert.equal(j.controls.size(), n, "nothing appended"); assert.equal(s.n, 0);
  // journal not abort-ready: no blocked attestation yet
  const m2 = manifest(); const j2 = V2.createMemoryJournalV2({ manifest: m2 }); let h2;
  for (const r of chain(RESERVED("disconnected").slice(0, 5), idOf(m2))) h2 = await j2.journal.append(r);
  const r2 = await runTestAbortBridge({ ...base(), manifest: m2, journal: j2.journal, trustedHead: { ...h2 } });
  assert.deepEqual([r2.outcome, r2.code, r2.operatorCoreInvocations], ["REFUSED_BEFORE_START", "JOURNAL_NOT_ABORT_READY", 0]);
  // read faults: torn / rejected / hung (bounded by the guard)
  for (const [mode, want] of [["torn", "JOURNAL_READ_INVALID"], ["reject", "JOURNAL_READ_REJECTED"]]) {
    const x = await readyJournal("disconnected", { faults: { read: { 1: mode } } });
    const r = await runTestAbortBridge({ ...base(), manifest: x.m, journal: x.j.journal, trustedHead: x.head });
    assert.deepEqual([r.outcome, r.code, r.operatorCoreInvocations], ["REFUSED_BEFORE_START", want, 0], mode);
  }
  const hx = await readyJournal("disconnected", { faults: { read: { 1: "hang" } } }); const fg = fakeGuard();
  const p = runTestAbortBridge({ ...base(), manifest: hx.m, journal: hx.j.journal, trustedHead: hx.head, guard: fg.guard }); await flush(); await fg.advance(5_001);
  const rh = await p; assert.deepEqual([rh.outcome, rh.code, rh.operatorCoreInvocations], ["REFUSED_BEFORE_START", "JOURNAL_READ_TIMEOUT", 0]);
  assert.ok(BRIDGE_OUTCOMES.includes(rh.outcome));
});

test("H4 start-record append rejected / hung / late / landed-but-unacknowledged / malformed ACK → STOPPED_START_UNACKED with ZERO helper calls and ZERO pool calls; no cleanup permission", async () => {
  for (const mode of ["reject", "hang", "late", "landed_hang", "badack"]) {
    const x = await readyJournal("airbnb", mode === "badack" ? {} : { faults: { append: { 7: mode } } });
    const fg = fakeGuard(); const pool = countingPool(); const s = { n: 0 };
    const journal = mode === "badack" ? Object.freeze({ read: x.j.journal.read, append: async (rec) => { const a = await x.j.journal.append(rec); return { seq: a.seq, hash: "0".repeat(64) }; } }) : x.j.journal;
    const p = runTestAbortBridge({ manifest: x.m, operator: operator(), journal, trustedHead: x.head, pool, env: ENV, guard: fg.guard, now: 1_800_000_000_000, operatorDeps: spyDeps(s) });
    await flush(); await fg.advance(5_001); await fg.advance(5_001);
    const r = await p;
    assert.equal(r.outcome, "STOPPED_START_UNACKED", mode); assert.deepEqual([r.operatorCoreInvocations, pool.calls, s.n, r.cleanupPermitted], [0, 0, 0, false], mode);
    const facts = V2.journalFactsV2((await x.j.journal.read()).records, x.m).facts;
    assert.equal(facts.cleanupEntryPermitted, false, mode);
    if (mode === "landed_hang" || mode === "badack") assert.equal(facts.abortStarted, true, `${mode}: the start may have landed — still no permission`);
  }
});

test("H5 mutation of the caller's manifest / operator / env objects during the bridge's awaits cannot change the bound start record", async () => {
  const x = await readyJournal("disconnected", { faults: { append: { 7: "reject" } } });
  let release; const gate = new Promise((r) => { release = r; });
  const journal = Object.freeze({ read: async () => { await gate; return x.j.journal.read(); }, append: (rec) => { seen.push(JSON.parse(JSON.stringify(rec))); return x.j.journal.append(rec); } });
  const seen = []; const op = operator(); const env = { ...ENV }; const m = JSON.parse(JSON.stringify(x.m));
  const p = runTestAbortBridge({ manifest: m, operator: op, journal, trustedHead: x.head, pool: countingPool(), env, guard: realGuard(), now: 1_800_000_000_000 });
  op.paymentIntentId = "pi_ABRTmutated0001"; op.expectedVersion = 99; env.MV_E7_TEST_ABORT = "disabled"; m.listing.connection = "airbnb"; m.phases.testAbortAfterReservation = false;
  release();
  const r = await p;
  assert.equal(r.outcome, "STOPPED_START_UNACKED");
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].abort.paymentIntentId, seen[0].abort.expectedVersion, seen[0].connection], [PI, 9, "disconnected"], "the start record carries the BOUND values");
});

test("H6 purity / scope: bridge imports only accepted modules; no env / fs / timers / network; v1 + accepted helper / operator core / M2-A bytes unchanged", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-test-abort.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.deepEqual([...code.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]), ["node:util", "./run-journal-memory-v2.mjs", "./run-guard.mjs",
    "../../lib/booking-db/test-abort.js", "../../lib/booking-db/repo.js", "../e7-operator/test-abort.mjs", "../../lib/checkout/intent-state.js"]);
  const stripped = code.replace(/"[^"]*"|`[^`]*`/g, "");
  for (const bad of ["process.", "fetch(", "setTimeout", "setInterval", "import(", "require(", "applyEvent", "UPDATE ", "INSERT ", "DELETE "]) assert.equal(stripped.includes(bad), false, bad);
  assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/.test(src.match(/\/\*m2c:[\s\S]*?\$[0-9]/g)?.join("") ?? ""), "postcheck SQL is SELECT only");
  const sha = (p) => createHash("sha256").update(readFileSync(new URL(`../${p}`, import.meta.url))).digest("hex");
  assert.deepEqual(Object.fromEntries(Object.keys(PINS).map((p) => [p, sha(p)])), PINS);
});
test("H7 injected clock faults (guard.now throws / non-finite / malformed): a STRUCTURED stopped result, never a top-level rejection; before the read → refused, nothing appended; before the operator → 0 core calls, start ACK + trusted head preserved", async () => {
  const faulty = (g, at, how) => { let k = 0; return Object.freeze({ observe: g.observe, now: () => { k += 1; if (k !== at) return g.now();
    if (how === "throw") throw new Error("clock fault"); if (how === "nan") return { ok: true, value: NaN }; if (how === "inf") return { ok: true, value: Infinity };
    if (how === "string") return { ok: true, value: "1" }; return null; }, calls: () => k }); };
  for (const how of ["throw", "nan", "inf", "string", "null"]) {
    // (a) before the initial journal read
    const x = await readyJournal(); const pool = countingPool(); const s = { n: 0 };
    const ga = faulty(realGuard(), 1, how);
    let ra; await assert.doesNotReject(async () => { ra = await runTestAbortBridge({ manifest: x.m, operator: operator(), journal: x.j.journal, trustedHead: x.head, pool, env: ENV,
      guard: { observe: ga.observe, now: ga.now }, now: 1_800_000_000_000, operatorDeps: spyDeps(s) }); }, how);
    assert.deepEqual([ra.outcome, ra.code, ra.operatorCoreInvocations, ra.startAck, ra.cleanupPermitted], ["REFUSED_BEFORE_START",
      how === "throw" ? "JOURNAL_READ_GUARD_NOW_FAULT" : "JOURNAL_READ_GUARD_NOW_INVALID", 0, null, false], how);
    assert.deepEqual([x.j.controls.readCalls(), x.j.controls.size(), pool.calls, s.n], [0, x.n, 0, 0], `${how}: the read was never started`);
    // (b) after the start ACK, before the operator core (now() call 3: read, start append, operator)
    const y = await readyJournal("airbnb"); const pool2 = countingPool(); const s2 = { n: 0 };
    const gb = faulty(realGuard(), 3, how);
    const rb = await runTestAbortBridge({ manifest: y.m, operator: operator(), journal: y.j.journal, trustedHead: y.head, pool: pool2, env: ENV,
      guard: { observe: gb.observe, now: gb.now }, now: 1_800_000_000_000, operatorDeps: spyDeps(s2) });
    assert.deepEqual([rb.outcome, rb.code, rb.operatorCoreInvocations, rb.requestHelperInvocations, rb.cleanupPermitted, rb.dbAbortApplied, rb.postcheck],
      ["STOPPED_BEFORE_OPERATOR", how === "throw" ? "GUARD_NOW_FAULT" : "GUARD_NOW_INVALID", 0, null, false, null, null], how);
    assert.deepEqual([pool2.calls, s2.n, y.j.controls.appendCalls(), y.j.controls.size()], [0, 0, y.n + 1, y.n + 1], `${how}: the start record landed and was ACKed; nothing was sent`);
    assert.deepEqual(rb.startAck, { seq: y.n + 1, hash: V2.recordHashV2((await y.j.journal.read()).records.at(-1)) });
    assert.deepEqual(rb.trustedHead, rb.startAck, `${how}: the trusted head is the last ACKed record`);
    const fy = V2.journalFactsV2((await y.j.journal.read()).records, y.m, { trustedHead: rb.trustedHead });
    assert.deepEqual([fy.anchored, fy.facts.abortStarted, fy.facts.abortReady, fy.facts.cleanupEntryPermitted], [true, true, false, false], `${how}: never re-requestable from this journal`);
    assert.ok(BRIDGE_OUTCOMES.includes(rb.outcome));
  }
});
// lib/booking-db/test-abort.js pin: a00952ca... -> 91724d9d... (root ruling b43935f0: the scoped hostaway_reservation evidence classification).
// lib/booking-db/test-abort.js pin: 91724d9d... -> 2638df7d... (root review of r02 candidate 49e7fe4e, F1/F2: recovered reconciled_found provenance with positivity bound to the one validated evidence read; exact pin, no loosening).
const PINS = {"scripts/e7-connected/run-manifest.mjs":"c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56","scripts/e7-connected/run-manifest-v2.mjs":"c19ab009b00b8c3877da53f20e436c1c6d4ac29d051ab1f21705d38fcf3cc7fd","scripts/e7-connected/run-journal-memory.mjs":"2712f01b0509d343d162b5fe7055878ade40f69d668915671441b81cbf87c700","scripts/e7-connected/run-journal-file.mjs":"265af8195dccbaae34817a9a16e2f09f4498b85638fae4abb779d5b0bd9cc4b1","scripts/e7-connected/run-core.mjs":"ad1dcbb29e7cb1ce0aac71ac178d903076d4e5cc293dd17f972c04b4beaa5afe","lib/booking-db/test-abort.js":"2638df7d3cceab9b0720c2ea1c7fa53d439900ef7392d944ef3663c331ebcc86","scripts/e7-operator/test-abort.mjs":"8abcb82ba49ed4b239d2c7a0f5251bb07d24fd95fece1c6580a4cad14532bff3","lib/checkout/intent-state.js":"16d1af5a7ea408b1a2e62f857a0027e71d8a1aa7b69c6d4f4bf7290823115615","db/migrations/0017_cancelled_pristine_capture_release.up.sql":"880f203b11cb4d2a9fe2317d6cb9fc8e00853b8c8ba41f44026d07aae9fd510e"};
