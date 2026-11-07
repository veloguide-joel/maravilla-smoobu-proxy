// E7 M2-G2a — binding-seam extraction PARITY harness (OFFLINE; contract claude/e7-run-real-r1-g2.md §1–§4).
//   * OLD = the IMMUTABLE pre-extraction tree `git archive 913f96258eb9ea6797ee0a60e5f2474408b2be6f` materialized into a temp dir; NEW = this
//     working tree. Every compared output is serialized and must be byte-identical (results, codes, hashes, heads, acks, pending states).
//   * DISCRIMINATION CONTROLS: the SAME comparison run against deliberately MUTATED copies of the OLD tree (hash domain / ACK / torn-tail /
//     landed-tail rules) must report mismatches — so the harness is shown to detect domain / ACK / tail drift.
//   * SYNTHETIC: manifests, records and chains are a LABELLED COPY (extended with the M2-C abort records) of
//     test/e7-connected-run-journal-v2.test.mjs:22–70. No DB, provider, network, credential. Needs the local git history (documented).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as NEWJ from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import * as NEWB from "../scripts/e7-connected/run-test-abort.mjs";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = "913f96258eb9ea6797ee0a60e5f2474408b2be6f";
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline G2a parity suite)"); };
let unhandled = 0; const onU = () => { unhandled += 1; };
process.on("unhandledRejection", onU);
const dirs = [];
let OLD; let OLDB;
/** materialize the immutable base tree (scripts + lib + package.json) into a fresh temp dir; optional text mutations of ONE file */
function materialize(mutations = []) {
  const d = mkdtempSync(join(tmpdir(), "g2a-old-")); dirs.push(d);
  const tar = execFileSync("git", ["-C", ROOT, "archive", BASE, "scripts", "lib", "package.json"], { maxBuffer: 1 << 28 });
  execFileSync("tar", ["-x", "-C", d], { input: tar });
  symlinkSync(join(ROOT, "node_modules"), join(d, "node_modules"));
  for (const [file, from, to] of mutations) {
    const p = join(d, file); const t = readFileSync(p, "utf8");
    assert.equal(t.split(from).length, 2, `control mutation anchor found exactly once in ${file}`);
    writeFileSync(p, t.replace(from, to));
  }
  return d;
}
const load = async (d, rel) => import(pathToFileURL(join(d, rel)).href);
before(async () => {
  const d = materialize();
  // the materialized OLD tree really is the pre-extraction code: byte-equal to `git show BASE:path`
  for (const f of ["run-journal-memory-v2.mjs", "run-journal-file-v2.mjs", "run-test-abort.mjs", "run-core-abort-v2.mjs"]) {
    const p = `scripts/e7-connected/${f}`;
    assert.equal(readFileSync(join(d, p), "utf8"), execFileSync("git", ["-C", ROOT, "show", `${BASE}:${p}`], { encoding: "utf8", maxBuffer: 1 << 26 }));
  }
  OLD = await load(d, "scripts/e7-connected/run-journal-memory-v2.mjs");
  OLDB = await load(d, "scripts/e7-connected/run-test-abort.mjs");
});
after(async () => {
  await new Promise((r) => setImmediate(r));
  globalThis.fetch = realFetch; process.off("unhandledRejection", onU);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  assert.equal(netAttempts, 0); assert.equal(unhandled, 0);
});

// ===== LABELLED COPY (extended) of test/e7-connected-run-journal-v2.test.mjs:22–70 =====
const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };
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
const W0 = { create: 0, capture: 0, record: 0, void: 0, cancel: 0 };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : JSON.stringify(v));
const H2 = (r) => createHash("sha256").update(`e7-run-journal-v2\n${canon(r)}`, "utf8").digest("hex");
const PI = "pi_SYNTHETICparity01"; const RID = "5100123";
const ABORT = (intentId) => ({ eventId: `test-abort:${intentId}:${PI}:${RID}`, expectedVersion: 7, paymentIntentId: PI, planHash: "a".repeat(64), reservationId: RID });
const RECEIPT = { appliedVersion: 8, state: "capture_failed", reason: "TEST_ABORT_REQUESTED", capture: { state: "pending", attempts: 0, dispatched: false },
  queued: ["alert.owner:pending", "hostaway.cancel_reservation:pending", "stripe.void_payment_intent:pending"], claimHeld: true };
const bodies = {
  RUN_STARTED: () => ({}),
  ATTESTED: (checkpoint) => ({ attestation: { checkpoint, evidenceRef: `synthetic/${checkpoint.toLowerCase()}` } }),
  STEP_STARTED: (phase, step, factory = { phase, reservationId: null }) => ({ phase, step, factory }),
  STEP_ENDED: (phase, step, o = {}) => ({ phase, step, result: "worked", state: "reservation_pending", actions: ["RESERVATION_STARTED->reservation_pending"], unlistedActions: 0, refusals: [], writes: { ...W0 }, ...o }),
  PHASE_ENDED: (phase, state = "reservation_confirmed") => ({ phase, state }),
  RUN_STOPPED: (code = "TIMEOUT_STEP", o = {}) => ({ code, outstanding: "NONE", effectsKnown: false, exclusion: "held", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 }, ...o }),
  RUN_ENDED: (o = {}) => ({ outcome: "ENDED_CONFIRMED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: "confirmed", writes: { ...W0, create: 1, capture: 1, record: 1 }, ...o }),
  ABORT_REQUEST_STARTED: (intentId) => ({ abort: ABORT(intentId) }),
  ABORT_ACCEPTED: (intentId) => ({ abort: ABORT(intentId), receipt: RECEIPT })
};
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
const abortRun = (c, iid) => [...RESERVED, ["ATTESTED", CK[c][1]], ["ABORT_REQUEST_STARTED", iid], ["ABORT_ACCEPTED", iid], ["STEP_STARTED", "cleanup", 1],
  ["STEP_ENDED", "cleanup", 1, { state: "cancelled", actions: ["VOID_SUCCEEDED", "RESERVATION_CANCELLED->cancelled"], writes: { ...W0, void: 1, cancel: 1 } }],
  ["PHASE_ENDED", "cleanup", "cancelled"], ["ATTESTED", CK[c][2]], ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: null, writes: { ...W0, create: 1, void: 1, cancel: 1 } }]];
const voidOnly = [["RUN_STARTED"], ["ATTESTED", "CALENDAR_BASELINE"], ["STEP_STARTED", "reservation", 1], ["STEP_ENDED", "reservation", 1, { state: "reservation_failed", actions: [] }],
  ["PHASE_ENDED", "reservation", "reservation_failed"], ["STEP_STARTED", "cleanup", 1], ["STEP_ENDED", "cleanup", 1, { state: "authorization_released", actions: ["VOID_SUCCEEDED"], writes: { ...W0, void: 1 } }],
  ["PHASE_ENDED", "cleanup", "authorization_released"], ["RUN_ENDED", { outcome: "ENDED_RELEASED", ownerCleanupRequired: null, writes: { ...W0, void: 1 } }]];
// ===== end of the labelled copy =====

// ---- serialization of ANY compared output (frozen objects, codes, errors, pending) -------------------------------------------------
const ser = (v) => JSON.stringify(v, (k, x) => (x instanceof Error ? { error: x.name, code: x.code } : typeof x === "function" ? "<fn>" : x));
const flush = async (n = 40) => { for (let i = 0; i < n; i++) await null; };
const settle = async (p) => Promise.race([p.then((x) => ({ ok: x }), (e) => ({ err: { name: e && e.name, code: e && e.code } })), flush().then(() => ({ pending: true }))]);

/** the CORPUS: every (manifest, records, variant) scenario; returns the list of serialized observations from module `J` */
async function observe(J) {
  const obs = [];
  const put = (label, v) => obs.push(`${label} ${ser(v)}`);
  const ids = {};
  for (const c of ["disconnected", "airbnb"]) for (const [pn, ph] of [["full", undefined], ["abort", ABORT_PHASES], ["res", RES_ONLY]]) {
    const m = manifest(c, ph);
    const b = J.bindManifestV2(m); put(`bind ${c}/${pn}`, b.ok ? { ...b.binding, manifest: undefined } : b);
    if (!b.ok) continue;
    const id = b.binding.identity; ids[`${c}/${pn}`] = id;
    const chains = { reserved: RESERVED, happy: happy(c), abort: abortRun(c, id.intentId), voidOnly };
    for (const [cn, specs] of Object.entries(chains)) {
      const full = chain(specs, id);
      const variants = { full };
      for (let k = 0; k <= full.length; k++) variants[`prefix${k}`] = full.slice(0, k);
      variants.tamperAt = full.map((r, i) => (i === 3 ? { ...r, at: r.at + 1 } : r));
      variants.swap = full.length > 3 ? [full[0], full[2], full[1], ...full.slice(3)] : full;
      variants.crossMode = chain(specs.map((s) => (s[0] === "ATTESTED" && s[1] !== "CALENDAR_BASELINE" ? ["ATTESTED", CK[c === "airbnb" ? "disconnected" : "airbnb"][1]] : s)), id);
      variants.wrongId = chain(specs, { ...id, runId: "synthetic-run-v2-9999" });
      variants.badPrev = full.map((r, i) => (i === 2 ? { ...r, prevHash: "f".repeat(64) } : r));
      variants.extraKey = full.map((r, i) => (i === 1 ? { ...r, extra: 1 } : r));
      for (const [vn, recs] of Object.entries(variants)) {
        const L = `${c}/${pn}/${cn}/${vn}`;
        const head = recs.length ? { seq: recs.length, hash: J.recordHashV2(recs.at(-1)) } : { seq: 0, hash: "0".repeat(64) };
        for (const [tn, th] of [["none", undefined], ["head", { trustedHead: head }], ["genesis", { trustedHead: { seq: 0, hash: "0".repeat(64) } }], ["wrong", { trustedHead: { seq: 1, hash: "e".repeat(64) } }], ["badOpt", { other: 1 }]]) {
          put(`validate ${L} ${tn}`, J.validateJournalV2(recs, m, th));
          put(`facts ${L} ${tn}`, J.journalFactsV2(recs, m, th));
          for (const tail of ["complete", "torn", "other"]) put(`start ${L} ${tn} ${tail}`, J.evaluateStartV2({ records: recs, tail }, m, th));
        }
        if (vn === "full" || vn === "tamperAt" || vn === "crossMode" || vn === "extraKey") for (const [i, r] of recs.entries()) {
          put(`record ${L} #${i}`, J.validateRecordV2(r, m)); put(`hash ${L} #${i}`, J.recordHashV2(r));
        }
      }
      // the in-memory journal: sequential appends with every fault mode at several positions; pending / late / landed classified
      for (const fault of [null, "reject", "hang", "late", "landed_hang"]) for (const at of [1, 3, full.length]) {
        const L = `${c}/${pn}/${cn}/mem/${fault}@${at}`;
        const mj = J.createMemoryJournalV2({ manifest: m, ...(fault ? { faults: { append: { [String(at)]: fault } } } : {}) });
        put(`mem ${L}`, mj.ok ? { identity: mj.identity } : mj);
        if (!mj.ok) continue;
        for (const r of full) {
          const s = await settle(mj.journal.append(r)); put(`append ${L} ${r.seq}`, s);
          if (s.pending && fault === "late") { put(`release ${L}`, mj.controls.release(at)); }
          if (s.pending && fault !== "late") { const nx = full[r.seq]; if (nx) put(`appendInFlight ${L} ${nx.seq}`, await settle(mj.journal.append(nx))); break; }   // serial rule observed
        }
        put(`read ${L}`, await settle(mj.journal.read()));
        put(`ctl ${L}`, [mj.controls.appendCalls(), mj.controls.readCalls(), mj.controls.size()]);
      }
    }
  }
  // option / manifest refusals
  for (const [n, v] of Object.entries({ nul: null, empty: {}, synthFalse: manifest("disconnected", undefined, { synthetic: false }), live: manifest("disconnected", undefined, { providerMode: { hostaway: "fake", stripe: "live" } }),
    v1: { ...manifest(), version: "e7-run-manifest-v1" }, extra: { ...manifest(), more: 1 } })) {
    put(`bindBad ${n}`, J.bindManifestV2(v)); put(`memBad ${n}`, J.createMemoryJournalV2({ manifest: v })); put(`valBad ${n}`, J.validateJournalV2([], v));
  }
  put("memOpts", [J.createMemoryJournalV2(null), J.createMemoryJournalV2({ manifest: manifest(), x: 1 }), J.createMemoryJournalV2({ manifest: manifest(), faults: { append: { 0: "reject" } } })]);
  put("startBad", [J.evaluateStartV2(null, manifest()), J.evaluateStartV2({ records: [] }, manifest()), J.evaluateStartV2({ records: [], tail: "complete", x: 1 }, manifest())]);
  return obs;
}
/** bridge refusals reached BEFORE any capability is used (the synchronous pre-start part of the shared body) */
async function observeBridge(B) {
  const obs = [];
  const m = manifest("disconnected", ABORT_PHASES);
  const base = { manifest: m, operator: {}, journal: { append: () => {}, read: () => {} }, trustedHead: { seq: 8, hash: "a".repeat(64) }, pool: {}, env: {}, guard: { observe: () => {}, now: () => {} }, now: 1 };
  const cases = { nul: null, empty: {}, missing: (({ pool, ...x }) => x)(base), extra: { ...base, more: 1 }, badManifest: { ...base, manifest: { ...m, synthetic: false } },
    notAbort: { ...base, manifest: manifest("disconnected", RES_ONLY) }, badOperator: base, badEnv: { ...base, operator: {}, env: { X: 1 } } };
  for (const [n, v] of Object.entries(cases)) obs.push(`bridge ${n} ${ser(await B.runTestAbortBridge(v))}`);
  return obs;
}
const diff = (a, b) => { const out = []; const n = Math.max(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i); return out; };

test("G2a-P1 journal parity: every v2 journal export byte-identical OLD (immutable 913f9625) vs NEW over the full corpus", async () => {
  const o = await observe(OLD); const n = await observe(NEWJ);
  assert.ok(o.length > 3000, `corpus size ${o.length}`);
  assert.equal(n.length, o.length);
  const d = diff(o, n);
  assert.deepEqual(d.slice(0, 5).map((i) => [o[i].slice(0, 160), n[i].slice(0, 160)]), [], `${d.length} mismatching observations`);
  // the corpus genuinely exercises acceptance AND refusal, both modes, abort records, ACKs, pending / late / landed tails
  const s = o.join("\n");
  for (const needle of ['"status":"ENDED"', '"status":"IN_PROGRESS"', '"code":"EMPTY_JOURNAL"', '"code":"JOURNAL_PARTIAL"', '"code":"TRUSTED_HEAD_MISMATCH"', '"code":"CHECKPOINT_MODE_MISMATCH"',
    '"code":"JOURNAL_CHAIN_INVALID"', '"code":"MANIFEST_MISMATCH"', '"cleanupEntryPermitted":true', '"abortReady":true', '{"pending":true}', '"code":"INJECTED_APPEND_FAILURE"', '"code":"APPEND_IN_FLIGHT"',
    "airbnb/abort/abort/full", "REAL_RUN_NOT_IN_THIS_SLICE"])
    assert.ok(s.includes(needle), `corpus covers ${needle}`);
});

test("G2a-P2 bridge parity: the shared body's pre-start refusals byte-identical OLD vs NEW", async () => {
  const o = await observeBridge(OLDB); const n = await observeBridge(NEWB);
  assert.deepEqual(n, o);
  assert.ok(o.some((x) => x.includes("MANIFEST_INVALID")) && o.some((x) => x.includes("MANIFEST_NOT_ABORT_PLAN")) && o.some((x) => x.includes("INPUT_INVALID")));
});

test("G2a-P3 DISCRIMINATION controls: mutated OLD copies (hash domain / ACK / torn tail / landed tail) are each detected by the same harness", async () => {
  const f = "scripts/e7-connected/run-journal-memory-v2.mjs";
  const controls = {
    hashDomain: [f, "export const JOURNAL_V2_HASH_PREFIX = `${RUN_JOURNAL_V2_VERSION}\\n`;", "export const JOURNAL_V2_HASH_PREFIX = `${RUN_JOURNAL_V2_VERSION}X\\n`;"],
    ackHash: [f, "const store = (rec) => { stored.push(rec); return freeze({ seq: rec.seq, hash: recordHashV2(rec) }); };", "const store = (rec) => { stored.push(rec); return freeze({ seq: rec.seq, hash: rec.prevHash }); };"],
    tornTail: [f, 'if (rr.tail === "torn") return freeze({ ok: false, code: "JOURNAL_PARTIAL" });', 'if (rr.tail === "torn") rr.tail = "complete";'],
    landedTail: [f, 'if (mode === "landed_hang") { inFlight = true; store(r); return new Promise(() => {}); }', 'if (mode === "landed_hang") { inFlight = true; return new Promise(() => {}); }']
  };
  const base = await observe(OLD);
  for (const [name, mut] of Object.entries(controls)) {
    const d = materialize([mut]);
    const J = await load(d, f);
    const o = await observe(J);
    const mism = diff(base, o).length;
    assert.ok(mism > 0, `control ${name} must be DETECTED (mismatches=${mism})`);
  }
});

test("G2a-S1 seam: *Bound APIs accept ONLY bindings minted by this module; copies / spreads / JSON / hand-built / v2-shaped objects refused; equal results otherwise", async () => {
  const m = manifest("airbnb", ABORT_PHASES);
  const br = NEWJ.bindManifestV2(m); assert.equal(br.ok, true);
  const B = br.binding;
  assert.equal(NEWJ.isBoundBindingV2(B), true);
  const recs = chain(abortRun("airbnb", B.identity.intentId), B.identity);
  const forged = { spread: { ...B }, json: JSON.parse(JSON.stringify(B)), clone: structuredClone({ ...B, manifest: { ...B.manifest } }), handBuilt: { identity: B.identity, checkpoints: B.checkpoints, phases: B.phases, facts: B.facts, manifest: B.manifest },
    frozenCopy: Object.freeze({ ...B }), proto: Object.create(B), otherModuleBinding: OLD.bindManifestV2(m).binding, nul: null, str: "e7-run-manifest-v2" };
  for (const [k, fb] of Object.entries(forged)) {
    assert.equal(NEWJ.isBoundBindingV2(fb), false, k);
    for (const r of [NEWJ.validateRecordBound(recs[0], fb), NEWJ.validateJournalBound(recs, fb), NEWJ.journalFactsBound(recs, fb), NEWJ.evaluateStartBound({ records: recs, tail: "complete" }, fb)])
      assert.deepEqual({ ...r }, { ok: false, code: "BINDING_UNVERIFIED" }, k);
    const bb = await NEWB.runTestAbortBridgeBound({ binding: fb, operator: {}, journal: { append: () => {}, read: () => {} }, trustedHead: { seq: 8, hash: "a".repeat(64) }, pool: {}, env: {}, guard: { observe: () => {}, now: () => {} }, now: 1 });
    assert.equal(bb.outcome, "REFUSED_BEFORE_START"); assert.equal(bb.code, "BINDING_UNVERIFIED", k); assert.equal(bb.operatorCoreInvocations, 0);
  }
  // a genuine binding gives EXACTLY the manifest-path results
  const th = { trustedHead: { seq: recs.length, hash: NEWJ.recordHashV2(recs.at(-1)) } };
  assert.equal(ser(NEWJ.validateJournalBound(recs, B, th)), ser(NEWJ.validateJournalV2(recs, m, th)));
  assert.equal(ser(NEWJ.journalFactsBound(recs.slice(0, 9), B, { trustedHead: { seq: 9, hash: NEWJ.recordHashV2(recs[8]) } })), ser(NEWJ.journalFactsV2(recs.slice(0, 9), m, { trustedHead: { seq: 9, hash: NEWJ.recordHashV2(recs[8]) } })));
  assert.equal(ser(NEWJ.evaluateStartBound({ records: [], tail: "complete" }, B)), ser(NEWJ.evaluateStartV2({ records: [], tail: "complete" }, m)));
  for (const r of recs) assert.equal(ser(NEWJ.validateRecordBound(r, B)), ser(NEWJ.validateRecordV2(r, m)));
  // the brand can only be minted from a VALID synthetic v2 manifest: no non-synthetic input reaches BOUND in G2a
  for (const bad of [manifest("airbnb", ABORT_PHASES, { synthetic: false }), manifest("airbnb", ABORT_PHASES, { providerMode: { hostaway: "real", stripe: "test" } })])
    assert.equal(NEWJ.bindManifestV2(bad).ok, false);
  // a bridge with a genuine binding runs the SAME body as the manifest entry: identical refusal for an invalid operator
  const common = { operator: {}, journal: { append: () => {}, read: () => {} }, trustedHead: { seq: 8, hash: "a".repeat(64) }, pool: {}, env: {}, guard: { observe: () => {}, now: () => {} }, now: 1 };
  assert.equal(ser(await NEWB.runTestAbortBridgeBound({ binding: B, ...common })), ser(await NEWB.runTestAbortBridge({ manifest: m, ...common })));
});

test("G2a-S2 extraction boundary: the core flow is NOT exported, takes no hooks; public entrypoints / constants unchanged; synthetic gates retained", async () => {
  const core = await import("../scripts/e7-connected/run-core-abort-v2.mjs");
  const oldCore = await load(dirs[0], "scripts/e7-connected/run-core-abort-v2.mjs");
  // M2-G2b (contract §9): the old export names + EXACTLY the two intended R1 exports; every old constant still byte-equal below
  assert.deepEqual(Object.keys(core).sort(), [...Object.keys(oldCore), "R1_AFTER_RESERVATION_BUDGET_MS", "runReservationAbortR1"].sort(), "old export names + the two G2b R1 exports");
  for (const k of Object.keys(oldCore)) if (typeof oldCore[k] !== "function") assert.equal(ser(core[k]), ser(oldCore[k]), `constant ${k}`);
  assert.ok(!("runAbortFlowV2" in core));
  const src = readFileSync(join(ROOT, "scripts/e7-connected/run-core-abort-v2.mjs"), "utf8");
  assert.ok(/^async function runAbortFlowV2\(o, B\) \{$/m.test(src), "flow signature: (options, binding) — no hook parameter");
  assert.ok(src.includes('manifest.synthetic !== true\n    || manifest.providerMode.hostaway !== "fake" || manifest.providerMode.stripe !== "mock") return invalid("PHASE_PLAN_UNSUPPORTED");'), "synthetic-only gate retained verbatim");
  const v2src = readFileSync(join(ROOT, "scripts/e7-connected/run-manifest-v2.mjs"), "utf8");
  assert.equal(v2src, execFileSync("git", ["-C", ROOT, "show", `${BASE}:scripts/e7-connected/run-manifest-v2.mjs`], { encoding: "utf8" }), "v2 validator byte-exact");
  // the four changed modules are the ONLY changed runtime files vs the base (plus the G1 preflight's two mechanical origin pins)
  const changed = execFileSync("git", ["-C", ROOT, "diff", "--name-only", BASE, "--", "scripts", "lib", "db", ".github"], { encoding: "utf8" }).trim().split("\n").filter(Boolean).sort();
  // M2-G2b (contract §9): + run-plan-v1.mjs, whose ONLY change is the two foundation-closure paths the R1 consumer now imports
  assert.deepEqual(changed, ["scripts/e7-connected/run-core-abort-v2.mjs", "scripts/e7-connected/run-journal-file-v2.mjs", "scripts/e7-connected/run-journal-memory-v2.mjs",
    "scripts/e7-connected/run-plan-v1.mjs", "scripts/e7-connected/run-preflight-r1.mjs", "scripts/e7-connected/run-test-abort.mjs"]);
  const planDiff = execFileSync("git", ["-C", ROOT, "diff", "-U0", BASE, "--", "scripts/e7-connected/run-plan-v1.mjs"], { encoding: "utf8" }).split("\n").filter((l) => /^[+-][^+-]/.test(l));
  const added = (sign) => planDiff.filter((l) => l[0] === sign).join("\n").match(/"[^"]+"/g);
  assert.deepEqual([...new Set(added("+"))].filter((x) => !(added("-") || []).includes(x)).sort(), ['"scripts/e7-connected/run-binding-r1.mjs"', '"scripts/e7-connected/run-preflight-r1.mjs"'],
    "run-plan-v1: only the two closure paths added");
  assert.deepEqual((added("-") || []).filter((x) => !added("+").includes(x)), [], "run-plan-v1: nothing removed");
  const pf = execFileSync("git", ["-C", ROOT, "diff", "-U0", BASE, "--", "scripts/e7-connected/run-preflight-r1.mjs"], { encoding: "utf8" });
  const changedLines = pf.split("\n").filter((l) => /^[+-][^+-]/.test(l));
  assert.equal(changedLines.length, 4, "exactly the two origin-pin lines changed in the G1 preflight");
  assert.ok(changedLines.every((l) => /"scripts\/e7-connected\/run-(core-abort-v2|test-abort)\.mjs": "[0-9a-f]{64}"/.test(l)));
});
