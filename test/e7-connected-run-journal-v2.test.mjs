// E7 M2-B — MODE-BOUND v2 in-memory journal foundation (OFFLINE UNIT; no DB, no network, no worker, no file journal).
// SYNTHETIC: every manifest, record, evidence reference below is synthetic. Memory-only: proves nothing about files / fsync / hosted stores.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as V2 from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import * as J1 from "../scripts/e7-connected/run-journal-memory.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline journal v2 suite)"); };
let unhandled = 0; const onU = () => { unhandled += 1; };
process.on("unhandledRejection", onU);
after(async () => { await new Promise((r) => setImmediate(r)); globalThis.fetch = realFetch; process.off("unhandledRejection", onU); assert.equal(netAttempts, 0); assert.equal(unhandled, 0); });

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await null; };
const PENDING = Symbol("pending");
const stateOf = async (p) => Promise.race([p.then((x) => ({ x }), (e) => ({ e })), flush(40).then(() => PENDING)]);
const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };
const OTHER = { disconnected: "airbnb", airbnb: "disconnected" };
/** a VALID synthetic v2 manifest */
const manifest = (connection = "disconnected", phases = { capture: true, recording: true, testAbortAfterReservation: false }, over = {}) => ({
  version: "e7-run-manifest-v2", runId: "synthetic-run-v2-0001", intentId: "00000000-0000-4000-8000-0000000000c2", baselineCommit: "0".repeat(40),
  synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" },
  listing: { id: 891001, currency: "USD", refFieldId: 777009, timeZone: "America/Mazatlan", connection },
  expectedRef: "MV-SYNTH02", stay: { arrival: "2026-12-04", departure: "2026-12-06", guests: 2 }, amountMinor: 50000, pricing: { rateBps: 1000 },
  stripeAccountId: "acct_1SyntheticRunner", hostawayAccountLabel: { accountRef: "acct-test-1", clientSnapshotId: "client-RUN" },
  phases, paymentMethod: phases.recording ? "credit_card" : null,
  cleanup: { reservedNotConfirmed: "synthetic/cleanup-reserved", captured: "synthetic/cleanup-captured", confirmed: "synthetic/cleanup-confirmed" },
  automationsReviewed: "synthetic/automations", checkpoints: [...CK[connection]], ...over
});
const ABORT_PHASES = { capture: false, recording: false, testAbortAfterReservation: true };
const RES_ONLY = { capture: false, recording: false, testAbortAfterReservation: false };
const CAP_ONLY = { capture: true, recording: false, testAbortAfterReservation: false };
/** identity INDEPENDENTLY derived: the manifest's own validated hash */
const idOf = (m) => { const v = validateRunManifestV2(m); assert.equal(v.ok, true, v.code);
  return { manifestVersion: "e7-run-manifest-v2", connection: m.listing.connection, runId: m.runId, intentId: m.intentId, baselineCommit: m.baselineCommit, manifestHash: v.hash }; };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const H2 = (r) => createHash("sha256").update(`e7-run-journal-v2\n${canon(r)}`, "utf8").digest("hex");
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
/** a chain of [event, ...args] specs with seq / prevHash computed INDEPENDENTLY in the v2 domain */
function chain(specs, id, over = {}) {
  const out = []; let prev = "0".repeat(64);
  for (const [i, [event, ...args]] of specs.entries()) {
    const r = { v: 2, seq: i + 1, prevHash: prev, ...id, at: 1_700_000_000_000 + i, event, ...bodies[event](...args), ...(over[i + 1] || {}) };
    out.push(r); prev = H2(r);
  }
  return out;
}
const RESERVED = [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1],
  ["STEP_STARTED", "reservation", 2], ["STEP_ENDED", "reservation", 2, { state: "reservation_confirmed", actions: ["RESERVATION_SUCCEEDED->reservation_confirmed"], writes: { ...W0, create: 1 } }],
  ["PHASE_ENDED", "reservation"]];
const happy = (c) => [...RESERVED, ["ATTESTED", CK[c][1]], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "payment_captured", actions: ["CAPTURE_SUCCEEDED->payment_captured"] }],
  ["PHASE_ENDED", "capture", "payment_captured"], ["STEP_STARTED", "recording", 1], ["STEP_ENDED", "recording", 1, { state: "confirmed", actions: ["RECORDED->confirmed"] }],
  ["PHASE_ENDED", "recording", "confirmed"], ["RUN_ENDED"]];
/** capture failed → two-leg cleanup → cancelled → reopened (mode name) → released */
const cleanupCancelled = (c) => [...RESERVED, ["ATTESTED", CK[c][1]], ["STEP_STARTED", "capture", 1], ["STEP_ENDED", "capture", 1, { state: "capture_failed", actions: ["CAPTURE_CLAIMED"] }],
  ["PHASE_ENDED", "capture", "capture_failed"], ["STEP_STARTED", "cleanup", 1], ["STEP_ENDED", "cleanup", 1, { state: "cancelled", actions: ["VOID_SUCCEEDED", "RESERVATION_CANCELLED->cancelled"], writes: { ...W0, void: 1, cancel: 1 } }],
  ["PHASE_ENDED", "cleanup", "cancelled"], ["ATTESTED", CK[c][2]], ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 } }]];
const mk = (m, o = {}) => { const r = V2.createMemoryJournalV2({ manifest: m, ...o }); assert.equal(r.ok, true, r.code); return r; };
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof V2.JournalError); assert.deepEqual(Object.keys(e), ["name", "code"]); return e.code; } };
const appendAll = async (journal, recs) => { const acks = []; for (const r of recs) acks.push(await journal.append(r)); return acks; };

test("J1 happy chains in BOTH modes: identity derived from the validated manifest; every ack = an INDEPENDENT v2-domain head; frozen reads; start → RUN_ENDED", async () => {
  for (const c of ["disconnected", "airbnb"]) for (const specs of [happy(c), cleanupCancelled(c)]) {
    const m = manifest(c); const id = idOf(m); const recs = chain(specs, id);
    const { journal, identity } = mk(m);
    assert.deepEqual({ ...identity }, id, "identity = manifest-derived fields + COMPUTED v2 manifest hash");
    const acks = await appendAll(journal, recs);
    assert.deepEqual(acks.at(-1), { seq: recs.length, hash: H2(recs.at(-1)) });
    const rd = await journal.read();
    assert.ok(Object.isFrozen(rd) && Object.isFrozen(rd.records) && rd.records.every(Object.isFrozen));
    assert.deepEqual(JSON.parse(JSON.stringify(rd.records)), recs);
    assert.deepEqual(V2.evaluateStartV2(rd, m, { trustedHead: { seq: recs.length, hash: H2(recs.at(-1)) } }), { ok: false, code: "RUN_ENDED", anchored: true });
    const v = V2.validateJournalV2(recs, m); assert.equal(v.ok, true, v.code); assert.equal(v.status, "ENDED"); assert.equal(v.anchored, false);
  }
  const m = manifest("airbnb"); assert.deepEqual(V2.evaluateStartV2({ records: [], tail: "complete" }, m), { ok: true, code: "EMPTY_JOURNAL", dbEligibilityRequired: true, anchored: false });
  assert.equal(V2.JOURNAL_V2_HASH_PREFIX, "e7-run-journal-v2\n"); assert.equal(V2.RECORD_VERSION_V2, 2);
});

test("J2 binding comes ONLY from an actually validated v2 manifest: invalid / v1 manifests refuse; no identity / connection override; caller mutation after construction changes nothing", async () => {
  for (const bad of [{ ...manifest(), checkpoints: CK.airbnb }, { ...manifest(), version: "e7-run-manifest-v1" }, { ...manifest(), synthetic: false }, null, {}]) {
    assert.deepEqual(V2.createMemoryJournalV2({ manifest: bad }), { ok: false, code: "MANIFEST_INVALID" });
    assert.deepEqual(V2.validateJournalV2([], bad), { ok: false, code: "MANIFEST_INVALID" });
  }
  // the accepted v1 fixture shape is not a v2 manifest
  const { connection, ...l1 } = manifest().listing; void connection;
  assert.deepEqual(V2.createMemoryJournalV2({ manifest: { ...manifest(), listing: l1 } }), { ok: false, code: "MANIFEST_INVALID" });
  for (const extra of [{ identity: idOf(manifest()) }, { connection: "airbnb" }, { manifestHash: "a".repeat(64) }]) {
    assert.deepEqual(V2.createMemoryJournalV2({ manifest: manifest(), ...extra }), { ok: false, code: "JOURNAL_OPTIONS_INVALID" });
  }
  const m = manifest("disconnected"); const id = idOf(m);
  const { journal, identity } = mk(m);
  m.listing.connection = "airbnb"; m.checkpoints = [...CK.airbnb]; m.phases.capture = false;      // mutate the CALLER object after construction
  assert.equal(identity.connection, "disconnected");
  const recs = chain(happy("disconnected"), id);
  await appendAll(journal, recs);                                // still disconnected mode, capture still planned
  assert.equal(V2.bindManifestV2(manifest("airbnb")).binding.identity.manifestHash !== id.manifestHash, true);
  const b = V2.bindManifestV2(manifest("airbnb")).binding;
  assert.deepEqual({ ...b.checkpoints }, { baseline: "CALENDAR_BASELINE", blocked: "AIRBNB_BLOCKED", reopened: "AIRBNB_REOPENED" });
  assert.ok(Object.isFrozen(b) && Object.isFrozen(b.identity) && Object.isFrozen(b.phases));
});

test("J3 cross-mode attestations refused in append AND replay (incl. re-hashed hostile chains); forged connection / identity / other-mode manifest refused", async () => {
  for (const c of ["disconnected", "airbnb"]) {
    const m = manifest(c); const id = idOf(m); const o = OTHER[c];
    // append: the other mode's blocked / reopened names
    { const { journal } = mk(m); await appendAll(journal, chain(RESERVED, id));
      const cross = chain([...RESERVED, ["ATTESTED", CK[o][1]]], id).at(-1);
      assert.equal(await codeOf(journal.append(cross)), "CHECKPOINT_MODE_MISMATCH"); }
    { const recs = chain(cleanupCancelled(c), id); const { journal } = mk(m); await appendAll(journal, recs.slice(0, -2));
      const cross = chain([...cleanupCancelled(c).slice(0, -2), ["ATTESTED", CK[o][2]]], id).at(-1);
      assert.equal(await codeOf(journal.append(cross)), "CHECKPOINT_MODE_MISMATCH"); }
    // replay: a hostile chain that substitutes the other mode's names, correctly RE-HASHED end to end
    for (const swap of [1, 2]) {
      const specs = cleanupCancelled(c).map((s) => (s[0] === "ATTESTED" && s[1] === CK[c][swap] ? ["ATTESTED", CK[o][swap]] : s));
      const forged = chain(specs, id);
      const v = V2.validateJournalV2(forged, m);
      assert.equal(v.ok, false); assert.equal(v.code, "CHECKPOINT_MODE_MISMATCH", `${c} swap ${swap}`);
      assert.equal(V2.evaluateStartV2({ records: forged, tail: "complete" }, m).code, "CHECKPOINT_MODE_MISMATCH");
    }
    // a forged connection field (re-hashed) is an identity mismatch; so is validating against the other mode's manifest
    const forgedConn = chain(happy(c), { ...id, connection: o });
    assert.equal(V2.validateJournalV2(forgedConn, m).code, "MANIFEST_MISMATCH");
    assert.equal(V2.validateJournalV2(chain(happy(c), id), manifest(o)).code, "MANIFEST_MISMATCH");
    { const { journal } = mk(m); assert.equal(await codeOf(journal.append(forgedConn[0])), "IDENTITY_MISMATCH"); }
    // the other mode's FULL valid chain (its own identity) never validates under this manifest
    const otherFull = chain(happy(o), idOf(manifest(o)));
    assert.equal(V2.validateJournalV2(otherFull, m).code, "MANIFEST_MISMATCH");
    // garbage checkpoint names are field errors, never permissions
    const garbage = chain([...RESERVED, ["ATTESTED", "CALENDAR_BLOCKED_X"]], id);
    assert.equal(V2.validateJournalV2(garbage, m).code, "JOURNAL_MALFORMED");
  }
  // identity field-by-field (each re-hashed): every field is bound
  const m = manifest(); const id = idOf(m);
  for (const [k, v] of [["runId", "synthetic-run-v2-0009"], ["intentId", "00000000-0000-4000-8000-0000000000c9"], ["baselineCommit", "1".repeat(40)], ["manifestHash", "b".repeat(64)]]) {
    assert.equal(V2.validateJournalV2(chain(happy("disconnected"), { ...id, [k]: v }), m).code, "MANIFEST_MISMATCH", k);
  }
  // a changed manifest field (same run id / intent) changes the bound hash → mismatch
  assert.equal(V2.validateJournalV2(chain(happy("disconnected"), id), manifest("disconnected", undefined, { amountMinor: 50001 })).code, "MANIFEST_MISMATCH");
});

test("J4 checkpoint ordering with the mode's EXACT names: baseline before any work; blocked only after reservation_confirmed; reopened only after a cancelling cleanup; early / missing / duplicate refused", async () => {
  for (const c of ["disconnected", "airbnb"]) {
    const m = manifest(c); const id = idOf(m); const [BASE, BLK, REO] = CK[c];
    const bad = [
      [["RUN_STARTED"], ["STEP_STARTED", "reservation", 1]],                                                     // no baseline
      [["RUN_STARTED"], ["ATTESTED", BLK]],                                                                    // blocked first
      [["RUN_STARTED"], ["ATTESTED", BASE], ["ATTESTED", BASE]],                                              // duplicate
      [...RESERVED.slice(0, 4), ["ATTESTED", BASE]],                                                          // baseline after work
      [...RESERVED.slice(0, 4), ["ATTESTED", BLK]],                                                           // blocked before reservation ended
      [...RESERVED, ["STEP_STARTED", "capture", 1]],                                                          // capture without blocked
      [...RESERVED, ["ATTESTED", REO]],                                                                       // reopened without cancellation
      [...RESERVED, ["ATTESTED", BLK], ["ATTESTED", BLK]],                                                   // duplicate blocked
      [...happy(c).slice(0, -1).filter((s) => !(s[0] === "ATTESTED" && s[1] === BLK)), ["RUN_ENDED"]]       // terminal without blocked
    ];
    for (const specs of bad) {
      const recs = chain(specs, id);
      const v = V2.validateJournalV2(recs, m); assert.equal(v.ok, false, JSON.stringify(specs.at(-1))); assert.equal(v.code, "JOURNAL_MALFORMED");
      const { journal } = mk(m);
      let got = null; for (const r of recs) { got = await codeOf(journal.append(r)); if (got !== "RESOLVED") break; }
      assert.equal(got, "ORDER_INVALID", `${c}: ${JSON.stringify(specs.at(-1))}`);
    }
    // released WITH a standing reservation and no reopen requires the exact cleanup key; a reopen without cancellation is refused
    const released = [...cleanupCancelled(c).slice(0, -2), ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 } }]];
    assert.equal(V2.validateJournalV2(chain(released, id), m).code, "JOURNAL_MALFORMED", "cancelled reservation released without the reopened attestation");
  }
});

test("J5 manifest phase restrictions: capture / recording work refused when the flag is false (append and replay); outcomes needing an unplanned phase refused", async () => {
  for (const c of ["disconnected", "airbnb"]) {
    for (const [phases, specs, what] of [[RES_ONLY, [...RESERVED, ["ATTESTED", CK[c][1]], ["STEP_STARTED", "capture", 1]], "capture"],
      [CAP_ONLY, happy(c).slice(0, 12), "recording"], [ABORT_PHASES, [...RESERVED, ["ATTESTED", CK[c][1]], ["STEP_STARTED", "capture", 1]], "capture (abort plan)"]]) {
      const m = manifest(c, phases); const id = idOf(m); const recs = chain(specs, id);
      assert.deepEqual(V2.validateJournalV2(recs, m), { ok: false, code: "PHASE_NOT_PLANNED", at: recs.length }, what);
      const { journal } = mk(m); await appendAll(journal, recs.slice(0, -1));
      assert.equal(await codeOf(journal.append(recs.at(-1))), "PHASE_NOT_PLANNED", what);
    }
    // planned-phase success paths: reservation-only and capture-only end with their exact keys
    for (const [phases, specs] of [[RES_ONLY, [...RESERVED, ["ATTESTED", CK[c][1]], ["RUN_ENDED", { outcome: "ENDED_RESERVED_NOT_CAPTURED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]]],
      [CAP_ONLY, [...happy(c).slice(0, 11), ["RUN_ENDED", { outcome: "ENDED_CAPTURED_NOT_RECORDED", ownerCleanupRequired: "captured", writes: { ...W0, create: 1, capture: 1 } }]]]]) {
      const m = manifest(c, phases); const v = V2.validateJournalV2(chain(specs, idOf(m)), m); assert.equal(v.ok, true, v.code); assert.equal(v.status, "ENDED");
    }
  }
});

test("J6 testAbortAfterReservation is bound but NOTHING pretends an abort happened: no cleanup or release from reservation_confirmed; the honest end is reserved-not-captured with its owner cleanup key", async () => {
  for (const c of ["disconnected", "airbnb"]) {
    const m = manifest(c, ABORT_PHASES); const id = idOf(m);
    assert.notEqual(id.manifestHash, idOf(manifest(c, RES_ONLY)).manifestHash, "the abort flag is hash-bound");
    assert.equal(V2.validateJournalV2(chain(happy(c).slice(0, 7), idOf(manifest(c, RES_ONLY))), m).code, "MANIFEST_MISMATCH", "a no-abort journal is not this run");
    const fake = [
      [...RESERVED, ["STEP_STARTED", "cleanup", 1]],                                                                  // cleanup straight from reservation_confirmed
      [...RESERVED, ["ATTESTED", CK[c][1]], ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: null, writes: { ...W0, create: 1 } }]],
      [...RESERVED, ["ATTESTED", CK[c][1]], ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]],
      [...RESERVED, ["ATTESTED", CK[c][1]], ["ATTESTED", CK[c][2]]]                                                   // reopened with nothing cancelled
    ];
    for (const specs of fake) {
      const recs = chain(specs, id);
      assert.equal(V2.validateJournalV2(recs, m).code, "JOURNAL_MALFORMED", JSON.stringify(specs.at(-1)));
      const { journal } = mk(m); await appendAll(journal, recs.slice(0, -1));
      assert.equal(await codeOf(journal.append(recs.at(-1))), "ORDER_INVALID");
    }
    const honest = [...RESERVED, ["ATTESTED", CK[c][1]], ["RUN_ENDED", { outcome: "ENDED_RESERVED_NOT_CAPTURED", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }]];
    const v = V2.validateJournalV2(chain(honest, id), m); assert.equal(v.ok, true, v.code);
    assert.ok(!Object.keys(V2).some((k) => /abort/i.test(k)), "no abort API in this foundation");
  }
});

test("J7 terminal / duplicate / replay / serial-append rules and fault controls (reject / hang / late / landed_hang); a refusal never mutates history", async () => {
  const m = manifest("airbnb"); const id = idOf(m); const recs = chain(happy("airbnb"), id);
  { const { journal, controls } = mk(m); await appendAll(journal, recs);
    const extra = chain([...happy("airbnb"), ["RUN_STOPPED"]], id).at(-1);
    assert.equal(await codeOf(journal.append(extra)), "APPEND_AFTER_TERMINAL"); assert.equal(controls.size(), recs.length);
    assert.equal(await codeOf(journal.append(recs.at(-1))), "CHAIN_MISMATCH", "replay of an acknowledged record"); }
  { const dup = chain([["RUN_STARTED"], ["RUN_STARTED"]], id); const { journal } = mk(m); await journal.append(dup[0]); assert.equal(await codeOf(journal.append(dup[1])), "ORDER_INVALID"); }
  { const { journal, controls } = mk(m, { faults: { append: { 2: "late" } } });
    await journal.append(recs[0]); const p2 = journal.append(recs[1]);
    assert.equal(await codeOf(journal.append(recs[2])), "APPEND_IN_FLIGHT");
    assert.equal(await stateOf(p2), PENDING); assert.equal(controls.size(), 1);
    assert.equal(controls.release(2), true); assert.deepEqual(await p2, { seq: 2, hash: H2(recs[1]) }); assert.equal(controls.size(), 2);
    assert.deepEqual(await journal.append(recs[2]), { seq: 3, hash: H2(recs[2]) }); }
  { const { journal, controls } = mk(m, { faults: { append: { 1: "reject", 2: "landed_hang" } } });
    assert.equal(await codeOf(journal.append(recs[0])), "INJECTED_APPEND_FAILURE"); assert.equal(controls.size(), 0);
    const p = journal.append(recs[0]); assert.equal(await stateOf(p), PENDING); assert.equal(controls.size(), 1, "landed but never acknowledged");
    assert.equal(await codeOf(journal.append(recs[1])), "APPEND_IN_FLIGHT"); }
  { const { journal } = mk(m, { faults: { read: { 1: "torn", 2: "reject" } } });
    assert.deepEqual(V2.evaluateStartV2(await journal.read(), m), { ok: false, code: "JOURNAL_PARTIAL" });
    assert.equal(await codeOf(journal.read()), "INJECTED_READ_FAILURE"); }
  // interrupted step → RESTART_AMBIGUOUS (never resume)
  const open = chain(RESERVED.slice(0, 3), id);
  assert.deepEqual(V2.evaluateStartV2({ records: open, tail: "complete" }, m), { ok: false, code: "RESTART_AMBIGUOUS", interruptedStep: true, anchored: false });
});

test("J8 integrity is relative to an INDEPENDENT trusted head: an unanchored consistent forgery validates (documented limit); the head detects rewrite / truncation / extra tail; reorder / corrupt / torn refused", () => {
  const m = manifest("disconnected"); const id = idOf(m); const recs = chain(happy("disconnected"), id);
  const head = { seq: recs.length, hash: H2(recs.at(-1)) };
  const rewritten = chain(happy("disconnected"), id, { 4: { at: 1_800_000_000_000 } });              // a consistent re-hashed rewrite
  assert.equal(V2.validateJournalV2(rewritten, m).ok, true, "chain alone is not authentication (documented)");
  assert.deepEqual(V2.validateJournalV2(rewritten, m, { trustedHead: head }), { ok: false, code: "TRUSTED_HEAD_MISMATCH" });
  assert.deepEqual(V2.validateJournalV2(recs.slice(0, -1), m, { trustedHead: head }), { ok: false, code: "TRUSTED_HEAD_MISMATCH" }, "truncation");
  const tailExtra = chain([...happy("disconnected").slice(0, 7), ["ATTESTED", "CALENDAR_BLOCKED"]], id);
  assert.deepEqual(V2.validateJournalV2(tailExtra, m, { trustedHead: { seq: 7, hash: H2(tailExtra[6]) } }), { ok: false, code: "TRUSTED_HEAD_MISMATCH" }, "extra tail");
  assert.equal(V2.validateJournalV2(recs, m, { trustedHead: head }).anchored, true);
  const reordered = [recs[0], recs[2], recs[1], ...recs.slice(3)];
  assert.equal(V2.validateJournalV2(reordered, m).code, "JOURNAL_CHAIN_INVALID");
  const corrupt = recs.map((r, i) => (i === 5 ? { ...r, at: r.at + 1 } : r));
  assert.deepEqual(V2.validateJournalV2(corrupt, m), { ok: false, code: "JOURNAL_CHAIN_INVALID", at: 7 }, "a changed byte breaks the next prevHash");
  assert.equal(V2.validateJournalV2(recs.map((r, i) => (i === 3 ? { ...r, v: 1 } : r)), m).code, "JOURNAL_MALFORMED");
  for (const th of [{ seq: -1, hash: head.hash }, { seq: 1, hash: "x" }, { seq: 1 }, "head"]) assert.equal(V2.validateJournalV2(recs, m, { trustedHead: th }).code, "TRUSTED_HEAD_INVALID");
  assert.equal(V2.validateJournalV2(recs, m, { other: 1 }).code, "TRUSTED_HEAD_INVALID");
  assert.deepEqual(V2.validateJournalV2([], m, { trustedHead: { seq: 0, hash: "0".repeat(64) } }), { ok: true, status: "EMPTY", head: null, anchored: true });
  for (const rr of [{ records: recs }, { records: recs, tail: "partial" }, null, [recs]]) assert.equal(V2.evaluateStartV2(rr, m).code, "READ_RESULT_INVALID");
});

test("J9 v1 ⇄ v2 journals cross-refuse: no relabel / migration / adoption", async () => {
  const m = manifest("airbnb"); const id2 = idOf(m);
  const id1 = { runId: id2.runId, intentId: id2.intentId, manifestHash: id2.manifestHash, baselineCommit: id2.baselineCommit };
  const H1 = (r) => createHash("sha256").update(`e7-run-journal-v1\n${canon(r)}`, "utf8").digest("hex");
  const v1recs = []; let prev = "0".repeat(64);
  for (const [i, [event, ...args]] of happy("airbnb").entries()) { const r = { v: 1, seq: i + 1, prevHash: prev, ...id1, at: 1_700_000_000_000 + i, event, ...bodies[event](...args) }; v1recs.push(r); prev = H1(r); }
  assert.equal(J1.validateJournal(v1recs, id1).ok, true, "control: a valid v1 journal");
  assert.equal(V2.validateJournalV2(v1recs, m).code, "JOURNAL_MALFORMED", "v2 refuses v1 records");
  const relabelled = v1recs.map((r) => ({ ...r, v: 2, manifestVersion: "e7-run-manifest-v2", connection: "airbnb" }));     // relabel WITHOUT re-hashing
  assert.equal(V2.validateJournalV2(relabelled, m).code, "JOURNAL_CHAIN_INVALID", "a relabelled v1 chain is not a v2 chain");
  const v2recs = chain(happy("airbnb"), id2);
  assert.equal(J1.validateJournal(v2recs, id1).code, "JOURNAL_MALFORMED", "v1 refuses v2 records");
  assert.equal(J1.validateRecord(v2recs[0]).code, "RECORD_SHAPE");
  assert.equal(V2.validateRecordV2(v1recs[0], m).code, "RECORD_SHAPE");
  const { journal } = mk(m); assert.equal(await codeOf(journal.append(v1recs[0])), "RECORD_INVALID");
  const v1j = J1.createMemoryJournal({ identity: id1 }); assert.equal(v1j.ok, true);
  assert.equal(await (async () => { try { await v1j.journal.append(v2recs[0]); return "RESOLVED"; } catch (e) { return e.code; } })(), "RECORD_INVALID");
  // the two hash domains never coincide for the same record body
  assert.notEqual(V2.recordHashV2(V2.validateRecordV2(v2recs[0], m).record), H1(v2recs[0]));
});

test("J10 hostile inputs: refused code-only without running getters / toJSON; mutation of caller objects during async append / after read cannot change stored history", async () => {
  const m = manifest("disconnected"); const id = idOf(m); const recs = chain(happy("disconnected"), id);
  let calls = 0;
  const getter = Object.defineProperty({ ...recs[0] }, "event", { get: () => { calls += 1; return "RUN_STARTED"; }, enumerable: true });
  const toJ = { ...recs[0], toJSON() { calls += 1; return recs[0]; } };
  const sym = { ...recs[0] }; sym[Symbol("s")] = 1;
  const prox = new Proxy({ ...recs[0] }, { get(t, k) { calls += 1; return t[k]; } });
  const { journal, controls } = mk(m);
  for (const bad of [getter, toJ, sym, prox, [recs[0]], null, "RUN_STARTED", { ...recs[0], at: new Number(1) }, { ...recs[0], connection: new String("disconnected") }]) {
    assert.equal(await codeOf(journal.append(bad)), "RECORD_INVALID");
  }
  assert.equal(calls, 0); assert.equal(controls.size(), 0);
  const getterManifest = Object.defineProperty(manifest(), "runId", { get: () => { calls += 1; return "synthetic-run-v2-0001"; }, enumerable: true });
  // contract (= v1 journal options rule): an accessor ANYWHERE in the options is refused by the options snapshot first
  assert.deepEqual(V2.createMemoryJournalV2({ manifest: getterManifest }), { ok: false, code: "JOURNAL_OPTIONS_INVALID" });
  assert.deepEqual(V2.validateJournalV2([], getterManifest), { ok: false, code: "MANIFEST_INVALID" }); assert.equal(calls, 0);
  // async mutation: a 'late' append's caller object is changed while unacknowledged; the landed copy is the validated one
  const j2 = mk(m, { faults: { append: { 2: "late" } } });
  await j2.journal.append(recs[0]);
  const live = JSON.parse(JSON.stringify(recs[1]));
  const p = j2.journal.append(live);
  live.attestation.checkpoint = "AIRBNB_BLOCKED"; live.connection = "airbnb"; live.seq = 99;
  j2.controls.release(2); assert.deepEqual(await p, { seq: 2, hash: H2(recs[1]) });
  const rd = await j2.journal.read();
  assert.deepEqual(JSON.parse(JSON.stringify(rd.records[1])), recs[1]);
  assert.throws(() => { "use strict"; rd.records[1].attestation.checkpoint = "AIRBNB_BLOCKED"; }, TypeError);
  assert.throws(() => { "use strict"; rd.records.push(recs[2]); }, TypeError);
});

test("J11 purity / scope: exact import list; no timer / env / fs / network / DB / worker / abort; accepted v1 manifest, journals, run-core bytes unchanged", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-journal-memory-v2.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.deepEqual([...code.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]),
    ["node:crypto", "node:util", "./run-manifest.mjs", "./run-manifest-v2.mjs", "./run-journal-memory.mjs"]);
  const stripped = code.replace(/"[^"]*"/g, "");
  for (const bad of ["process.", "fetch(", "setTimeout", "setInterval", "import(", "require(", "globalThis", "applyEvent", "requestTestAbort"]) {
    assert.equal(stripped.includes(bad), false, bad);
  }
  const sha = (p) => createHash("sha256").update(readFileSync(new URL(`../${p}`, import.meta.url))).digest("hex");
  assert.deepEqual(Object.fromEntries(Object.keys(PINS).map((p) => [p, sha(p)])), PINS);
});
const PINS = {"scripts/e7-connected/run-manifest.mjs":"c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56","scripts/e7-connected/run-manifest-v2.mjs":"c19ab009b00b8c3877da53f20e436c1c6d4ac29d051ab1f21705d38fcf3cc7fd","scripts/e7-connected/run-journal-memory.mjs":"2712f01b0509d343d162b5fe7055878ade40f69d668915671441b81cbf87c700","scripts/e7-connected/run-journal-file.mjs":"265af8195dccbaae34817a9a16e2f09f4498b85638fae4abb779d5b0bd9cc4b1","scripts/e7-connected/run-core.mjs":"ad1dcbb29e7cb1ce0aac71ac178d903076d4e5cc293dd17f972c04b4beaa5afe"};
