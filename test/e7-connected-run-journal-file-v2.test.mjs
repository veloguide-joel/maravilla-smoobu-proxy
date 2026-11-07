// E7 M2-E — v2 FILE journal + separately persisted head: UNIT tests over the REAL Node fs in fresh temp directories (no in-memory fs
// model). Faults are injected by a LABELLED wrapper around the accepted createNodeFsAdapter (it calls the real fs, then refuses /
// shortens / hangs / rejects-after at an exact (file, operation, count) point). These prove ORDER and refusal logic — NOT power-loss
// durability. SYNTHETIC values only; no DB, no provider, no network. Test-only tampering of temp fixtures is labelled SYNTHETIC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, unlinkSync, renameSync, symlinkSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as V2 from "../scripts/e7-connected/run-journal-memory-v2.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";
import { buildAbortExpectation } from "../scripts/e7-operator/test-abort.mjs";
import { createNodeFsAdapter, openFileJournal } from "../scripts/e7-connected/run-journal-file.mjs";
import { openFileJournalV2, readJournalForRecoveryV2, journalFileNameV2, headFileNameV2, NO_PERMISSION } from "../scripts/e7-connected/run-journal-file-v2.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let unhandled = 0; const onU = () => { unhandled += 1; }; process.on("unhandledRejection", onU);
const BASE = mkdtempSync(join(tmpdir(), "e7-m2e-"));
after(async () => { await new Promise((r) => setImmediate(r)); process.off("unhandledRejection", onU); rmSync(BASE, { recursive: true, force: true }); assert.equal(unhandled, 0); });
let dirN = 0;
const dirs = () => { dirN += 1; const j = join(BASE, `j${dirN}`); const h = join(BASE, `h${dirN}`); mkdirSync(j, { mode: 0o700 }); mkdirSync(h, { mode: 0o700 }); return { j, h }; };

// ===== LABELLED COPY of test/e7-connected-run-test-abort.test.mjs:17–55 (synthetic manifest + v2 chain fixtures) =====
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
// ===== end of the labelled copy =====
const M = manifest("disconnected");
const ID = idOf(M);
const paths = (d, m = M) => ({ j: join(d.j, journalFileNameV2(m.runId)), h: join(d.h, headFileNameV2(m.runId)) });

/** LABELLED fault wrapper over the REAL node fs adapter: tag = journal | head | jlock | hlock; ops counted per tag */
function faultFs(rule = () => null) {
  const real = createNodeFsAdapter(); const log = []; const counts = {}; const gates = [];
  const tag = (p) => (p.endsWith(".lock") ? (p.includes("e7-head-v2") ? "hlock" : "jlock") : p.includes("e7-head-v2") ? "head" : p.includes("e7-journal-v2") ? "journal" : "other");
  const at = (t, op) => { const k = `${t}:${op}`; counts[k] = (counts[k] ?? 0) + 1; log.push(`${k}#${counts[k]}`); return rule(t, op, counts[k]); };
  const hang = () => { let release; const p = new Promise((r) => { release = r; }); gates.push(release); return p; };
  const wrapH = (t, h) => Object.freeze({
    write: async (buf, off, len) => { const f = at(t, "write"); if (f === "reject") throw Object.assign(new Error("EIO"), { code: "EIO" });
      if (f === "zero") return { bytesWritten: 0 }; if (f === "partial") { await h.write(buf, off, Math.max(1, Math.floor(len / 2))); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      if (f === "hang") await hang(); return h.write(buf, off, len); },
    sync: async () => { const f = at(t, "sync"); if (f === "reject") throw Object.assign(new Error("EIO"), { code: "EIO" }); if (f === "hang") await hang();
      await h.sync(); if (f === "after") throw Object.assign(new Error("EIO"), { code: "EIO" }); },
    read: (...a) => { at(t, "read"); return h.read(...a); }, stat: () => { at(t, "stat"); return h.stat(); }, close: () => { at(t, "close"); return h.close(); } });
  const adapter = Object.freeze({ platform: real.platform, uid: real.uid,
    realpath: (p) => { log.push("realpath"); return real.realpath(p); }, lstat: (p) => real.lstat(p),
    open: async (p, kind) => { const t = tag(p); const f = at(t, `open:${kind}`); if (f === "reject") throw Object.assign(new Error("EIO"), { code: "EIO" }); return wrapH(t, await real.open(p, kind)); },
    openDir: async (p) => { const t = p.includes(`${BASE}/h`) ? "dir:head" : "dir:journal"; const d = await real.openDir(p);
      return Object.freeze({ sync: async () => { const f = at(t, "sync"); if (f === "reject") throw Object.assign(new Error("EIO"), { code: "EIO" }); await d.sync(); }, close: () => d.close() }); },
    unlink: (p) => { at(tag(p), "unlink"); return real.unlink(p); } });
  return { adapter, log, counts, release: () => { const g = gates.shift(); if (g) g(); return !!g; } };
}
const bytesOf = (p) => (existsSync(p) ? readFileSync(p) : null);
const snapDir = (d) => JSON.stringify([d.j, d.h].map((x) => readdirSync(x).sort().map((f) => { const s = statSync(join(x, f)); return [f, s.size, s.mtimeMs, s.ino, readFileSync(join(x, f)).toString("hex")]; })));
const ACK = (r) => ({ seq: r.seq, hash: H2(r) });
async function writeChain(d, specs, o = {}) {
  const f = o.fs ?? faultFs();
  const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: o.manifest ?? M, fsAdapter: f.adapter });
  assert.equal(op.ok, true, JSON.stringify(op));
  const recs = chain(specs, idOf(o.manifest ?? M)); const acks = [];
  for (const r of recs) acks.push(await op.journal.append(r));
  return { op, recs, acks, f };
}
const READY7 = (c = "disconnected") => [...RESERVED(c), ["ABORT_REQUEST_STARTED"]];
const READY8 = (c = "disconnected") => [...READY7(c), ["ABORT_ACCEPTED"]];

test("U1 genesis: both locks, both files, BOTH directory fsyncs before ok; every ACK strictly after journal fsync AND head fsync; real-fs read / close / reopen refusal / recovery", async () => {
  const d = dirs(); const f = faultFs();
  const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
  assert.equal(op.ok, true, JSON.stringify(op));
  const openLog = f.log.filter((x) => !x.startsWith("realpath") && !/:(read|stat|close)#/.test(x));
  assert.deepEqual(openLog, ["jlock:open:lock-create#1", "jlock:write#1", "jlock:sync#1", "hlock:open:lock-create#1", "hlock:write#1", "hlock:sync#1",
    "journal:open:journal-create#1", "journal:sync#1", "head:open:journal-create#1", "head:sync#1", "dir:journal:sync#1", "dir:head:sync#1"], "names durable before ok");
  assert.deepEqual({ ...op.status().dirSync }, { journal: "synced", head: "synced" });
  const recs = chain(FULL("disconnected"), ID);
  for (const r of recs) {
    const mark = f.log.length;
    const ack = await op.journal.append(r);
    f.log.push("ACK");
    const seg = f.log.slice(mark).filter((x) => /:(write|sync)#|^ACK$/.test(x)).map((x) => x.replace(/#\d+$/, ""));
    assert.deepEqual(seg, ["journal:write", "journal:sync", "head:write", "head:sync", "ACK"], `seq ${r.seq}`);
    assert.deepEqual({ ...ack }, ACK(r));
  }
  const rd = await op.journal.read();
  assert.deepEqual([rd.tail, rd.records.map(canon)], ["complete", recs.map(canon)], "exact ABORT v2 round-trip (canonical bytes)");
  assert.deepEqual(rd.records.map(H2), recs.map(H2));
  const p = paths(d);
  assert.equal(readFileSync(p.h, "utf8").trim().split("\n").length, recs.length);
  assert.deepEqual({ ...(await op.close()) }, { fileClose: "closed", headLock: "released", journalLock: "released" });
  assert.deepEqual([existsSync(`${p.j}.lock`), existsSync(`${p.h}.lock`), existsSync(p.j), existsSync(p.h)], [false, false, true, true]);
  // REAL node fs adapter (default, no wrapper): reopen is refused (creation only); recovery round-trips the real files
  const again = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M });
  assert.equal(again.code, "JOURNAL_EXISTS");
  const before = snapDir(d);
  const rec = await readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M, trustedHead: ACK(recs.at(-1)) });
  assert.equal(snapDir(d), before, "recovery mutates nothing");
  assert.deepEqual([rec.relation, rec.records, rec.headRecords, rec.effects, rec.suppliedHead, rec.chain.status, rec.chain.factsAre], ["AT_ESCROW_HEAD", 13, 13, "UNKNOWN_FROM_DISK", "MATCH_TIP", "ENDED", "EVIDENCE_NOT_PERMISSION"]);
  assert.deepEqual({ ...rec.permission }, { ...NO_PERMISSION });
  assert.deepEqual([...rec.unresolved], ["LAST_RECORD_ACK_DELIVERY_UNKNOWN", "ABORT_RECEIPT_ACK_UNKNOWN", "TERMINAL_RECORDED"]);
  assert.equal(rec.chain.facts.abortAccepted, true, "a durable receipt shows in the EVIDENCE facts …");
  assert.equal(rec.permission.cleanup, false, "… and is never a recovery cleanup permission");
});

test("U2 every write / fsync failure point: no ACK, POISONED (no later append / read), never repaired; what the disk then shows", async () => {
  const cases = [
    ["journal", "write", "reject", "AT_ESCROW_HEAD", []], ["journal", "write", "zero", "AT_ESCROW_HEAD", []], ["journal", "write", "partial", "AT_ESCROW_HEAD", ["TORN_JOURNAL_TAIL"]],
    ["journal", "sync", "reject", "JOURNAL_AHEAD_1", ["UNESCROWED_LAST_RECORD"]], ["head", "write", "reject", "JOURNAL_AHEAD_1", ["UNESCROWED_LAST_RECORD"]],
    ["head", "write", "partial", "JOURNAL_AHEAD_1", ["UNESCROWED_LAST_RECORD", "TORN_HEAD_TAIL"]],
    ["head", "sync", "reject", "AT_ESCROW_HEAD", []], ["head", "sync", "after", "AT_ESCROW_HEAD", []]   // lost ACK with BOTH synced: indistinguishable on disk
  ];
  for (const [t, opn, how, rel, extra] of cases) {
    const label = `${t}:${opn}:${how}`;
    const d = dirs(); const nth = 3;                                         // the 3rd append fails
    const f = faultFs((tt, o, k) => (tt === t && o === opn && k === nth + (t === "journal" || t === "head" ? (opn === "sync" ? 1 : 0) : 0) ? how : null));
    const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
    assert.equal(op.ok, true, label);
    const recs = chain(READY7(), ID);
    for (let i = 0; i < nth - 1; i++) await op.journal.append(recs[i]);
    await assert.rejects(op.journal.append(recs[nth - 1]), (e) => typeof e.code === "string", label);
    assert.equal(op.status().state, "failed", label);
    await assert.rejects(op.journal.append(recs[nth - 1]), (e) => e.code === "JOURNAL_FAILED", `${label}: poisoned`);
    await assert.rejects(op.journal.read(), (e) => e.code === "JOURNAL_FAILED", label);
    const r = await readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M });
    const expN = rel === "AT_ESCROW_HEAD" && (t === "journal" && opn === "write") ? nth - 1 : nth;
    assert.deepEqual([r.relation, r.records], [rel, expN], `${label} ${JSON.stringify(r)}`);
    for (const x of extra) assert.ok(r.unresolved.includes(x), `${label}: ${x}`);
    assert.deepEqual({ ...r.permission }, { ...NO_PERMISSION });
    await op.close();
  }
});

test("U3 open-time failures (lock / file / directory fsync): refused, ONLY own locks released, created files left in place (never deleted), reopen refused", async () => {
  for (const [t, o, code] of [["dir:journal", "sync", "JOURNAL_DIR_SYNC_FAILED"], ["dir:head", "sync", "HEAD_DIR_SYNC_FAILED"], ["journal", "sync", "JOURNAL_IO_FAILED"],
    ["head", "open:journal-create", "JOURNAL_IO_FAILED"], ["hlock", "write", "JOURNAL_IO_FAILED"]]) {
    const d = dirs(); const f = faultFs((tt, oo) => (tt === t && oo === o ? "reject" : null));
    const r = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
    assert.equal(r.ok, false); assert.equal(r.code, code, `${t}:${o}`);
    const p = paths(d);
    // the head lock whose nonce write FAILED cannot be proven ours → it is LEFT for the owner (the accepted v1 rule); the proven journal lock is released
    assert.deepEqual([existsSync(`${p.j}.lock`), existsSync(`${p.h}.lock`)], [false, t === "hlock"], `${t}:${o}: only demonstrably-owned locks released`);
    if (t.startsWith("dir:") || t === "journal") {
      assert.equal(existsSync(p.j), true, `${t}:${o}: created journal kept`);
      assert.equal((await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M })).code, "JOURNAL_EXISTS");
    }
  }
});

test("U4 a hanging head fsync: no ACK, APPEND_IN_FLIGHT / JOURNAL_BUSY meanwhile, close() waits; release → that ACK resolves", async () => {
  const d = dirs(); const f = faultFs((t, o, k) => (t === "head" && o === "sync" && k === 3 ? "hang" : null));
  const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
  const recs = chain(READY7(), ID);
  await op.journal.append(recs[0]);
  let acked = null; const p = op.journal.append(recs[1]).then((a) => { acked = a; });
  for (let i = 0; i < 2000 && !f.log.some((x) => x === "head:sync#3"); i++) await new Promise((r) => setTimeout(r, 2));   // bounded poll for the real-fs hang point
  assert.ok(f.log.includes("head:sync#3"), "the hang point was reached");
  assert.equal(acked, null, "no ACK while the head fsync hangs");
  await assert.rejects(op.journal.append(recs[2]), (e) => e.code === "APPEND_IN_FLIGHT");
  await assert.rejects(op.journal.read(), (e) => e.code === "JOURNAL_BUSY");
  let closed = false; const cp = op.close().then(() => { closed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, false, "close waits for the started append");
  assert.equal(f.release(), true); await p; await cp;
  assert.deepEqual({ ...acked }, ACK(recs[1]));
});

test("U5 PAIRED histories with IDENTICAL durable bytes give the IDENTICAL diagnosis and ZERO permission: start record (ACK lost vs ACK delivered + operator possibly started) and receipt (lost vs delivered); escrow-equal vs journal-ahead receipt both withhold cleanup", async () => {
  for (const [label, specs] of [["start", READY7()], ["receipt", READY8()]]) {
    const n = specs.length;
    const a = dirs(); await writeChain(a, specs);                           // history A: every ACK delivered; then (say) the operator started; process dies (no close)
    const b = dirs(); const fb = faultFs((t, o, k) => (t === "head" && o === "sync" && k === n + 1 ? "after" : null));   // B: both synced, the LAST ACK lost
    const ob = await openFileJournalV2({ journalDir: b.j, headDir: b.h, manifest: M, fsAdapter: fb.adapter });
    const rb = chain(specs, ID);
    for (let i = 0; i < n - 1; i++) await ob.journal.append(rb[i]);
    await assert.rejects(ob.journal.append(rb[n - 1]));
    assert.deepEqual([bytesOf(paths(a).j), bytesOf(paths(a).h)].map(String), [bytesOf(paths(b).j), bytesOf(paths(b).h)].map(String), `${label}: identical durable bytes`);
    const ra = await readJournalForRecoveryV2({ journalDir: a.j, headDir: a.h, manifest: M });
    const rbb = await readJournalForRecoveryV2({ journalDir: b.j, headDir: b.h, manifest: M });
    assert.deepEqual(JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(rbb)), `${label}: the SAME diagnosis`);
    assert.deepEqual([ra.relation, ra.effects, { ...ra.permission }], ["AT_ESCROW_HEAD", "UNKNOWN_FROM_DISK", { ...NO_PERMISSION }]);
    assert.ok(ra.unresolved.includes("LAST_RECORD_ACK_DELIVERY_UNKNOWN"));
    assert.ok(ra.unresolved.includes(label === "start" ? "ABORT_STARTED_UNRECEIPTED" : "ABORT_RECEIPT_ACK_UNKNOWN"));
    await ob.close();
  }
  // receipt: journal-ahead (head write failed) vs escrow-equal (head synced, ACK lost): both withhold cleanup authority
  const c = dirs(); const fc = faultFs((t, o, k) => (t === "head" && o === "write" && k === 8 ? "reject" : null));
  const oc = await openFileJournalV2({ journalDir: c.j, headDir: c.h, manifest: M, fsAdapter: fc.adapter });
  const rc = chain(READY8(), ID); for (let i = 0; i < 7; i++) await oc.journal.append(rc[i]); await assert.rejects(oc.journal.append(rc[7]));
  const x = await readJournalForRecoveryV2({ journalDir: c.j, headDir: c.h, manifest: M });
  assert.deepEqual([x.relation, x.permission.cleanup, x.unresolved.includes("ABORT_RECEIPT_ACK_UNKNOWN"), x.unresolved.includes("UNESCROWED_LAST_RECORD"), x.chain.anchoredPrefix.seq],
    ["JOURNAL_AHEAD_1", false, true, true, 7]);
  await oc.close();
});

test("U6 malformed / missing / torn / head-ahead / gap / replaced / foreign / alias / symlink: recovery classifies and refuses, never repairs (SYNTHETIC tampering of temp fixtures)", async () => {
  const fresh = async (specs = READY7()) => { const d = dirs(); const w = await writeChain(d, specs); await w.op.close(); return { d, p: paths(d), w }; };
  const R = (d, o = {}) => readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M, ...o });
  const expect = async (d, rel, label) => { const before = snapDir(d); const r = await R(d); assert.equal(r.relation, rel, `${label}: ${JSON.stringify(r)}`); assert.deepEqual({ ...r.permission }, { ...NO_PERMISSION }); assert.equal(snapDir(d), before, `${label}: unchanged`); return r; };
  { const { d, p } = await fresh(); unlinkSync(p.h); await expect(d, "HEAD_MISSING", "missing head"); }
  { const { d, p } = await fresh(); unlinkSync(p.j); await expect(d, "JOURNAL_MISSING", "missing journal"); }
  { const d = dirs(); const r = await expect(d, "BOTH_MISSING", "both missing"); assert.equal(r.effects, "NO_RECORD_ON_DISK"); }
  { const d = dirs(); const o = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M }); await o.close(); const r = await expect(d, "GENESIS_EMPTY", "genesis"); assert.deepEqual([...r.unresolved], ["NO_RECORDS"]); }
  { const { d, p } = await fresh(); appendFileSync(p.h, '{"hash":"ab'); const r = await expect(d, "AT_ESCROW_HEAD", "torn head"); assert.ok(r.unresolved.includes("TORN_HEAD_TAIL")); }
  { const { d, p } = await fresh(); appendFileSync(p.j, '{"at":1'); const r = await expect(d, "AT_ESCROW_HEAD", "torn journal"); assert.ok(r.unresolved.includes("TORN_JOURNAL_TAIL")); }
  { const { d, p } = await fresh(); appendFileSync(p.h, `{"hash":"${"a".repeat(64)}","manifestHash":"${ID.manifestHash}","runId":"${M.runId}","seq":8,"v":2}\n`);
    const r = await expect(d, "HEAD_AHEAD", "head ahead"); assert.equal(r.chain.anchoredPrefix, null); }
  { const { d, p } = await fresh(); const lines = readFileSync(p.h, "utf8").split("\n").filter(Boolean); writeFileSync(p.h, `${lines.slice(0, 5).join("\n")}\n`, { mode: 0o600 });
    await expect(d, "GAP_GT_1", "gap > 1"); }
  { const { d, p } = await fresh(); const other = chain(READY7(), ID).map((r, i) => ({ ...r })); const alt = []; let prev = "0".repeat(64);
    for (const r of other) { const x = { ...r, prevHash: prev, at: r.at + 999 }; alt.push(x); prev = H2(x); }
    writeFileSync(p.j, alt.map((x) => `${canon(x)}\n`).join(""), { mode: 0o600 }); const r = await expect(d, "HASH_MISMATCH", "replaced journal"); assert.equal(r.at, 1); }
  { const { d, p } = await fresh(); const lines = readFileSync(p.h, "utf8").split("\n").filter(Boolean); lines[2] = lines[2].replace(M.runId, "synthetic-run-FOREIGN");
    writeFileSync(p.h, `${lines.join("\n")}\n`, { mode: 0o600 }); await expect(d, "HEAD_IDENTITY_MISMATCH", "foreign head line"); }
  { const m2 = manifest("airbnb", undefined, { runId: M.runId }); const d = dirs(); const w = await writeChain(d, READY7("airbnb"), { manifest: m2 }); await w.op.close();
    const r = await expect(d, "HEAD_IDENTITY_MISMATCH", "foreign manifest (head binds manifestHash)"); void r; }
  { const { d } = await fresh(); const r = await R({ j: d.j, h: d.j }); assert.equal(r.relation, "UNSAFE"); assert.equal(r.detail, "JOURNAL_DIR_ALIAS");
    assert.equal((await openFileJournalV2({ journalDir: d.j, headDir: d.j, manifest: M })).code, "JOURNAL_DIR_ALIAS"); }
  { const { d } = await fresh(); const link = join(BASE, `hlink${dirN}`); symlinkSync(d.h, link); const r = await R({ j: d.j, h: link }); assert.deepEqual([r.relation, r.detail], ["UNSAFE", "JOURNAL_DIR_UNSAFE"]); }
  { const { d, p } = await fresh(); const real = `${p.j}.real`; renameSync(p.j, real); symlinkSync(real, p.j); const r = await R(d); assert.equal(r.relation, "UNSAFE", JSON.stringify(r)); }
  // a file REPLACED (new inode) under a live writer: the next append / read refuses and poisons (journal and head separately)
  for (const which of ["j", "h"]) {
    const d = dirs(); const o = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M }); const recs = chain(READY7(), ID);
    await o.journal.append(recs[0]); const p = paths(d)[which]; copyFileSync(p, `${p}.copy`); renameSync(`${p}.copy`, p);
    await assert.rejects(o.journal.append(recs[1]), (e) => e.code === (which === "j" ? "JOURNAL_FILE_CHANGED" : "HEAD_FILE_CHANGED"), which);
    assert.equal(o.status().state, "failed"); await o.close();
  }
});

test("U7 a separately retained SUPPLIED trusted head is checked against the chain and NEVER replaced by the head-file tip; a coherent rollback of BOTH files is detected ONLY with it", async () => {
  const d = dirs(); const p = paths(d); const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M }); const recs = chain(READY7(), ID);
  for (const r of recs.slice(0, 4)) await op.journal.append(r);
  const snapJ = readFileSync(p.j); const snapH = readFileSync(p.h);              // SYNTHETIC: the state at seq 4
  for (const r of recs.slice(4)) await op.journal.append(r);
  await op.close();
  const R = (th) => readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M, ...(th === undefined ? {} : { trustedHead: th }) });
  assert.equal((await R(ACK(recs[6]))).suppliedHead, "MATCH_TIP");
  assert.equal((await R(ACK(recs[3]))).suppliedHead, "IN_CHAIN_BEHIND_TIP");
  const bad = await R({ seq: 3, hash: "f".repeat(64) }); assert.deepEqual([bad.suppliedHead, bad.unresolved.includes("SUPPLIED_HEAD_CONTRADICTS_FILES")], ["NOT_IN_CHAIN", true]);
  assert.equal((await R({ seq: 1, hash: "x" })).code, "TRUSTED_HEAD_INVALID");
  writeFileSync(p.j, snapJ, { mode: 0o600 }); writeFileSync(p.h, snapH, { mode: 0o600 });   // SYNTHETIC coherent rollback of BOTH files to seq 4
  const blind = await R(); assert.deepEqual([blind.relation, blind.records, blind.suppliedHead], ["AT_ESCROW_HEAD", 4, "NOT_SUPPLIED"], "without a retained head the rollback is UNDETECTABLE (documented limit)");
  const seen = await R(ACK(recs[6])); assert.deepEqual([seen.relation, seen.suppliedHead, seen.unresolved.includes("SUPPLIED_HEAD_CONTRADICTS_FILES")], ["AT_ESCROW_HEAD", "AHEAD_OF_FILES", true]);
  assert.equal(seen.chain.anchoredPrefix.seq, 4, "the head-file tip is reported, never substituted for the supplied head");
});

test("U8 v1 ⇄ v2 cross-refusal; v2 appends refuse foreign / out-of-order / malformed records BEFORE any I/O", async () => {
  // v2 record into the accepted v1 FILE journal: refused
  const d1 = dirs(); const v1id = { runId: M.runId, intentId: M.intentId, manifestHash: ID.manifestHash, baselineCommit: M.baselineCommit };
  const v1 = await openFileJournal({ dir: d1.j, identity: v1id }); assert.equal(v1.ok, true, JSON.stringify(v1));
  await assert.rejects(v1.journal.append(chain(READY7(), ID)[0]), (e) => typeof e.code === "string"); await v1.close();
  // v1-shaped record into v2: refused with no write
  const d = dirs(); const f = faultFs(); const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
  const writes0 = f.log.filter((x) => /:write#/.test(x)).length;
  const r0 = chain(READY7(), ID)[0];
  for (const bad of [{ ...r0, v: 1 }, { ...r0, seq: 2 }, { ...r0, runId: "synthetic-run-other" }, chain([["ATTESTED", "CALENDAR_BASELINE"]], ID)[0], chain(READY7("airbnb"), idOf(manifest("airbnb")))[0]]) {
    await assert.rejects(op.journal.append(bad), (e) => typeof e.code === "string");
  }
  assert.equal(f.log.filter((x) => /:write#/.test(x)).length, writes0, "refused before any write");
  assert.equal(op.status().state, "open", "a pre-I/O refusal does not poison");
  await op.close();
  // a v2 file under the v1 name is not a valid v1 history; v1 records under the v2 name are JOURNAL_INVALID (or CORRUPT) in recovery
  const d2 = dirs(); const w2 = await writeChain(d2, READY7()); await w2.op.close();
  const v2bytes = readFileSync(join(d2.j, journalFileNameV2(M.runId))); assert.ok(v2bytes.length > 0);
  const d3 = dirs(); writeFileSync(join(d3.j, `e7-journal-${M.runId}.jsonl`), v2bytes, { mode: 0o600 });
  const v1b = await openFileJournal({ dir: d3.j, identity: v1id });
  assert.equal(v1b.ok, true); assert.equal(v1b.status().historyValid, false, "v1 does not accept a v2 history"); await v1b.close();
  // a v1 history under the v2 names (with a matching-shape head file) is not a valid v2 journal
  const d4 = dirs(); const v1w = await openFileJournal({ dir: d4.j, identity: v1id }); assert.equal(v1w.ok, true); await v1w.close();
  const d5 = dirs(); copyFileSync(join(d2.h, headFileNameV2(M.runId)), join(d5.h, headFileNameV2(M.runId)));
  writeFileSync(join(d5.j, journalFileNameV2(M.runId)), `${canon({ v: 1, seq: 1, prevHash: "0".repeat(64), ...v1id, at: 1, event: "RUN_STARTED" })}\n`, { mode: 0o600 });
  const rx = await readJournalForRecoveryV2({ journalDir: d5.j, headDir: d5.h, manifest: M });
  assert.ok(["JOURNAL_INVALID", "CORRUPT"].includes(rx.relation), JSON.stringify(rx));
});

test("U9 two writers + partial lock acquisition: second writer refused without touching the first's locks; a foreign head lock → HEAD_LOCKED, ONLY our journal lock removed, foreign lock bytes intact; stale locks never auto-removed", async () => {
  const d = dirs(); const p = paths(d);
  const a = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M }); assert.equal(a.ok, true);
  const lockA = [readFileSync(`${p.j}.lock`, "utf8"), readFileSync(`${p.h}.lock`, "utf8")];
  const b = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M }); assert.equal(b.code, "JOURNAL_EXISTS");
  assert.deepEqual([readFileSync(`${p.j}.lock`, "utf8"), readFileSync(`${p.h}.lock`, "utf8")], lockA, "A's locks untouched");
  await a.journal.append(chain(READY7(), ID)[0]); await a.close();
  // locks only (files absent): a foreign head lock (SYNTHETIC other writer) → HEAD_LOCKED; our journal lock is released, theirs kept
  const e = dirs(); const pe = paths(e); writeFileSync(`${pe.h}.lock`, `${"9".repeat(32)}\n`, { mode: 0o600 });
  const c = await openFileJournalV2({ journalDir: e.j, headDir: e.h, manifest: M });
  assert.deepEqual([c.code, existsSync(`${pe.j}.lock`), readFileSync(`${pe.h}.lock`, "utf8")], ["HEAD_LOCKED", false, `${"9".repeat(32)}\n`]);
  writeFileSync(`${pe.j}.lock`, `${"8".repeat(32)}\n`, { mode: 0o600 });
  const c2 = await openFileJournalV2({ journalDir: e.j, headDir: e.h, manifest: M });
  assert.deepEqual([c2.code, readFileSync(`${pe.j}.lock`, "utf8")], ["JOURNAL_LOCKED", `${"8".repeat(32)}\n`], "a stale / foreign lock is never removed");
  // a crashed writer (no close): its locks stay; recovery reports them and removes nothing
  const g = dirs(); const w = await writeChain(g, READY7()); void w;
  const r = await readJournalForRecoveryV2({ journalDir: g.j, headDir: g.h, manifest: M });
  assert.deepEqual({ ...r.presence }, { journal: "present", head: "present", journalLock: "present", headLock: "present" });
});

test("U10 recovery makes ZERO mutations: only realpath / lstat / read-only opens / read / stat / close are called; directory bytes, sizes, mtimes, inodes unchanged", async () => {
  const d = dirs(); const w = await writeChain(d, READY8()); await w.op.close();
  const f = faultFs(); const before = snapDir(d);
  const r = await readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
  assert.equal(r.relation, "AT_ESCROW_HEAD");
  assert.deepEqual(f.log.filter((x) => !/^realpath$|:open:lock-read#|:(read|stat|close)#/.test(x)), [], "no write / sync / create / unlink / dir sync");
  assert.equal(snapDir(d), before);
});

test("U11 source pins: the new module imports only the accepted v1 codec/adapter, the v2 validators and node built-ins; no process / timers / fetch / env; accepted modules byte-exact", () => {
  const src = readFileSync(join(ROOT, "scripts/e7-connected/run-journal-file-v2.mjs"), "utf8");
  assert.deepEqual([...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]), ["node:path", "node:crypto", "node:util", "./run-manifest.mjs", "./run-journal-file.mjs", "./run-journal-memory-v2.mjs"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/"[^"]*"|`[^`]*`/g, "");
  for (const bad of ["process.", "setTimeout", "setInterval", "fetch(", "Date.", "import(", "require("]) assert.equal(code.includes(bad), false, bad);
  const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
  assert.deepEqual(Object.fromEntries(Object.keys(PINS).map((p) => [p, sha(p)])), PINS);
});
const PINS = {"scripts/e7-connected/run-journal-file.mjs":"265af8195dccbaae34817a9a16e2f09f4498b85638fae4abb779d5b0bd9cc4b1","scripts/e7-connected/run-journal-memory-v2.mjs":"4d342357a29f3e287ca5995737bea47ebdb8b07370a2bcc42c14837d5c8475e0","scripts/e7-connected/run-journal-memory.mjs":"2712f01b0509d343d162b5fe7055878ade40f69d668915671441b81cbf87c700","scripts/e7-connected/run-manifest.mjs":"c47f72eb2b9e898bdaca2ca20ffe7cea0befab006079953133810ce5651f6a56","scripts/e7-connected/run-manifest-v2.mjs":"c19ab009b00b8c3877da53f20e436c1c6d4ac29d051ab1f21705d38fcf3cc7fd","scripts/e7-connected/run-core.mjs":"ad1dcbb29e7cb1ce0aac71ac178d903076d4e5cc293dd17f972c04b4beaa5afe","scripts/e7-connected/run-core-abort-v2.mjs":"2b686e1e3bcbe2a5f837412d4a0a6a2c9864ebf232e2bd58bef67c8f36087771","scripts/e7-connected/run-test-abort.mjs":"57d97e1806fbaad83f76cf0b794cb45893a95d36456ad09b5acb7fd8b2f62b21","scripts/e7-connected/run-guard.mjs":"5d92cbf8a3dfb345ac876e1140ee6a2d6a27885f8bf6dcb506a5f346024e16a9","lib/booking-db/test-abort.js":"91724d9dcd6c3c514eef70b5d3f4a4458b7298106b0286a797506bd99b48f852"};

/** LABELLED short-write wrapper over the REAL node fs: journal / head writes are capped at `cap` bytes per call (a valid POSITIVE short
 *  count, written for real); `then(tag, n)` may turn the n-th call for a tag into "zero" (returns 0, writes nothing) or "reject". */
function shortFs(cap, then = () => null) {
  const real = createNodeFsAdapter(); const calls = []; const log = []; const n = {};
  const tagOf = (p) => (p.endsWith(".lock") ? "lock" : p.includes("e7-head-v2") ? "head" : p.includes("e7-journal-v2") ? "journal" : "other");
  const wrap = (t, h) => Object.freeze({
    write: async (buf, off, len) => {
      if (t !== "journal" && t !== "head") return h.write(buf, off, len);
      n[t] = (n[t] ?? 0) + 1; const f = then(t, n[t]);
      if (f === "zero") { calls.push({ t, off, len, wrote: 0 }); log.push(`${t}:write0`); return { bytesWritten: 0 }; }
      if (f === "reject") { calls.push({ t, off, len, wrote: "reject" }); log.push(`${t}:writeX`); throw Object.assign(new Error("EIO"), { code: "EIO" }); }
      const r = await h.write(buf, off, Math.min(len, cap)); calls.push({ t, off, len, wrote: r.bytesWritten }); log.push(`${t}:write`); return r;
    },
    sync: async () => { log.push(`${t}:sync`); return h.sync(); }, read: (...a) => h.read(...a), stat: () => h.stat(), close: () => h.close() });
  return { calls, log, adapter: Object.freeze({ platform: real.platform, uid: real.uid, realpath: real.realpath, lstat: real.lstat, unlink: real.unlink, openDir: real.openDir,
    open: async (p, kind) => wrap(tagOf(p), await real.open(p, kind)) }) };
}

test("U12 (root review of 01a9425) a valid POSITIVE short write is normal progress: the remaining bytes continue at the advanced offset (no duplicate prefix), bounded; both fsyncs still precede the ACK; exact bytes, valid chain + head on recovery", async () => {
  const d = dirs(); const f = shortFs(7);
  const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
  assert.equal(op.ok, true, JSON.stringify(op));
  const recs = chain(READY8(), ID); const acks = [];
  for (const r of recs) {
    const mark = f.log.length; const c0 = f.calls.length;
    acks.push(await op.journal.append(r)); f.log.push("ACK");
    const jl = Buffer.byteLength(`${canon(r)}\n`); const hl = Buffer.byteLength(`${canon({ v: 2, runId: M.runId, manifestHash: ID.manifestHash, seq: r.seq, hash: H2(r) })}\n`);
    for (const [t, total] of [["journal", jl], ["head", hl]]) {
      const cs = f.calls.slice(c0).filter((c) => c.t === t);
      assert.equal(cs.length, Math.ceil(total / 7), `${t} seq ${r.seq}: bounded continuation (one call per 7 bytes)`);
      cs.forEach((c, i) => { assert.equal(c.off, 7 * i, `${t} offset progression`); assert.equal(c.len, total - 7 * i, `${t} remaining length`); assert.equal(c.wrote, Math.min(7, total - 7 * i)); });
    }
    const seg = f.log.slice(mark).filter((x) => x !== "journal:write" && x !== "head:write");
    assert.deepEqual(seg, ["journal:sync", "head:sync", "ACK"], `seq ${r.seq}: journal fsync then head fsync then ACK`);
    const order = f.log.slice(mark); assert.ok(order.lastIndexOf("journal:write") < order.indexOf("journal:sync") && order.indexOf("journal:sync") < order.indexOf("head:write"));
  }
  assert.deepEqual(acks.map((a) => ({ ...a })), recs.map(ACK));
  const p = paths(d);
  assert.equal(readFileSync(p.j, "utf8"), recs.map((r) => `${canon(r)}\n`).join(""), "exact journal bytes — no duplicated prefix");
  assert.equal(readFileSync(p.h, "utf8"), recs.map((r) => `${canon({ v: 2, runId: M.runId, manifestHash: ID.manifestHash, seq: r.seq, hash: H2(r) })}\n`).join(""), "exact head bytes");
  assert.equal((await op.journal.read()).records.length, recs.length);
  await op.close();
  const rec = await readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M, trustedHead: ACK(recs.at(-1)) });
  assert.deepEqual([rec.relation, rec.suppliedHead, rec.records, rec.headRecords, rec.journalTail, rec.headTail], ["AT_ESCROW_HEAD", "MATCH_TIP", 8, 8, "complete", "complete"]);
  assert.deepEqual({ ...rec.permission }, { ...NO_PERMISSION });
  assert.equal((await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M })).code, "JOURNAL_EXISTS");
});

test("U13 (root review of 01a9425) positive short progress THEN zero / rejection: no ACK, poisoned, the persisted prefix is preserved (never repaired / truncated), later append and read refused — journal AND head", async () => {
  for (const [t, how] of [["journal", "zero"], ["journal", "reject"], ["head", "zero"], ["head", "reject"]]) {
    const label = `${t}:${how}`;
    const d = dirs(); const recs = chain(READY7(), ID);
    const firstLen = (x) => Buffer.byteLength(t === "journal" ? `${canon(x)}\n` : `${canon({ v: 2, runId: M.runId, manifestHash: ID.manifestHash, seq: x.seq, hash: H2(x) })}\n`);
    const callsFor1 = Math.ceil(firstLen(recs[0]) / 7);
    const failAt = callsFor1 + 3;                                         // the 2nd record: 2 positive 7-byte calls, then the failure
    const f = shortFs(7, (tt, k) => (tt === t && k === failAt ? how : null));
    const op = await openFileJournalV2({ journalDir: d.j, headDir: d.h, manifest: M, fsAdapter: f.adapter });
    assert.deepEqual({ ...(await op.journal.append(recs[0])) }, ACK(recs[0]), label);
    // code labels (runtime byte-exact): a ZERO head write → HEAD_IO_FAILED; a REJECTED write (journal or head) reaches the generic catch →
    // JOURNAL_IO_FAILED. Behaviour is identical: no ACK, poisoned.
    await assert.rejects(op.journal.append(recs[1]), (e) => e.code === (t === "head" && how === "zero" ? "HEAD_IO_FAILED" : "JOURNAL_IO_FAILED"), label);
    // fsyncs observed: open (1 each) + record 1 (1 each) + record 2's journal fsync only when its journal line completed
    assert.deepEqual([f.log.filter((x) => x === "journal:sync").length, f.log.filter((x) => x === "head:sync").length], t === "journal" ? [2, 2] : [3, 2], `${label}: no fsync after the failed write`);
    assert.equal(op.status().state, "failed", `${label}: poisoned`);
    await assert.rejects(op.journal.append(recs[1]), (e) => e.code === "JOURNAL_FAILED", label);
    await assert.rejects(op.journal.read(), (e) => e.code === "JOURNAL_FAILED", label);
    const p = paths(d);
    const l1j = `${canon(recs[0])}\n`; const l2j = `${canon(recs[1])}\n`;
    const h1 = `${canon({ v: 2, runId: M.runId, manifestHash: ID.manifestHash, seq: 1, hash: H2(recs[0]) })}\n`;
    const h2 = `${canon({ v: 2, runId: M.runId, manifestHash: ID.manifestHash, seq: 2, hash: H2(recs[1]) })}\n`;
    if (t === "journal") {
      assert.equal(readFileSync(p.j, "utf8"), l1j + l2j.slice(0, 14), `${label}: exactly the persisted 14-byte prefix, never truncated or repaired`);
      assert.equal(readFileSync(p.h, "utf8"), h1, `${label}: the head never advanced`);
    } else {
      assert.equal(readFileSync(p.j, "utf8"), l1j + l2j, `${label}: the journal line was complete + fsynced`);
      assert.equal(readFileSync(p.h, "utf8"), h1 + h2.slice(0, 14), `${label}: exactly the persisted head prefix`);
    }
    await op.close();
    const rec = await readJournalForRecoveryV2({ journalDir: d.j, headDir: d.h, manifest: M });
    assert.deepEqual([rec.relation, rec.records], t === "journal" ? ["AT_ESCROW_HEAD", 1] : ["JOURNAL_AHEAD_1", 2], `${label}: ${JSON.stringify(rec)}`);
    assert.ok(rec.unresolved.includes(t === "journal" ? "TORN_JOURNAL_TAIL" : "TORN_HEAD_TAIL"), label);
    assert.deepEqual({ ...rec.permission }, { ...NO_PERMISSION });
    assert.equal(readFileSync(p.j, "utf8").length > 0, true);
  }
});
