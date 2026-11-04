// E7 connected-test runner SLICE F — owner-run LOCAL FILE journal (OFFLINE; no PG, no network, no provider; root-runnable).
// LABELS
//   * REAL FS: round trips use real files in fresh os.tmpdir() directories; each test removes only its own artifacts.
//   * INJECTED FAULTS (labelled): `faulty()` wraps the module's own default node:fs adapter and changes ONE behaviour (short / invalid
//     bytesWritten, write / sync / read errors, hangs gated by the test, dir-sync errors, platform classification). Accepted workers /
//     core / A–D are never monkeypatched.
//   * CRASH: one child process is SIGKILLed in the middle of a deliberately split write (bounded wait; parent cleans up).
//   * SYNTHETIC records: built with D's own validateRecord + recordHash (exactly what the accepted core appends).
//   * No power-loss durability is claimed or tested.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, linkSync, mkdirSync, chmodSync, appendFileSync, renameSync, unlinkSync, existsSync, truncateSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { validateRecord, recordHash, validateJournal, evaluateStart, GENESIS_HASH, JournalError } from "../scripts/e7-connected/run-journal-memory.mjs";
import { createGuard, validateGuardDeps, isNativePromise } from "../scripts/e7-connected/run-guard.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import { openFileJournal, createNodeFsAdapter, parseJournalBytes, encodeRecordLine, journalFileName, MAX_LINE_BYTES, MAX_FILE_BYTES, LOCK_BYTES }
  from "../scripts/e7-connected/run-journal-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = join(ROOT, "scripts/e7-connected/run-journal-file.mjs");
let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline file-journal suite)"); };
const DIRS = [];
after(() => { globalThis.fetch = realFetch; for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });
const POSIX = process.platform !== "win32";
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "e7fj-")); DIRS.push(d); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settledWithin = (p, ms) => Promise.race([p.then((v) => ({ settled: true, v }), (e) => ({ settled: true, e })), sleep(ms).then(() => ({ settled: false }))]);
const codeOf = async (p) => { try { await p; return "RESOLVED"; } catch (e) { assert.ok(e instanceof JournalError && e.message === "JOURNAL_ERROR"); return e.code; } };

// ---- SYNTHETIC D records (the accepted core's ENDED_RESERVED_NOT_CAPTURED sequence) ----------------------------------------------
const ID = Object.freeze({ runId: "synthetic-run-f001", intentId: "00000000-0000-4000-8000-0000000000f1", manifestHash: "a".repeat(64), baselineCommit: "d365d8164c97e9b6d3970b3242d3984e35859f1a" });
const W0 = { cancel: 0, capture: 0, create: 0, record: 0, void: 0 };
const BODIES = [
  { event: "RUN_STARTED" },
  { event: "ATTESTED", attestation: { checkpoint: "CALENDAR_BASELINE", evidenceRef: "synthetic/calendar_baseline" } },
  { event: "STEP_STARTED", phase: "reservation", step: 1, factory: { phase: "reservation", reservationId: null } },
  { event: "STEP_ENDED", phase: "reservation", step: 1, result: "worked", state: "reservation_pending", actions: ["RESERVATION_STARTED->reservation_pending"], unlistedActions: 0, refusals: [], writes: W0 },
  { event: "STEP_STARTED", phase: "reservation", step: 2, factory: { phase: "reservation", reservationId: null } },
  { event: "STEP_ENDED", phase: "reservation", step: 2, result: "worked", state: "reservation_confirmed", actions: [], unlistedActions: 0, refusals: [], writes: { ...W0, create: 1 } },
  { event: "PHASE_ENDED", phase: "reservation", state: "reservation_confirmed" },
  { event: "ATTESTED", attestation: { checkpoint: "AIRBNB_BLOCKED", evidenceRef: "synthetic/airbnb_blocked" } },
  { event: "RUN_ENDED", outcome: "ENDED_RESERVED_NOT_CAPTURED", outstanding: "NONE", effectsKnown: true, exclusion: "held", ownerCleanupRequired: "reservedNotConfirmed", writes: { ...W0, create: 1 } }
];
function chain(id = ID, bodies = BODIES) {
  let prev = GENESIS_HASH; const out = [];
  bodies.forEach((b, i) => { const v = validateRecord({ v: 1, seq: i + 1, prevHash: prev, ...id, at: 1_800_000_000_000 + i, ...b }); assert.equal(v.ok, true, v.code); out.push(v.record); prev = recordHash(v.record); });
  return out;
}
const RECS = chain();
assert.equal(validateJournal(RECS, ID).status, "ENDED", "SYNTHETIC sequence is D-valid");
const bytesOf = (recs) => Buffer.concat(recs.map(encodeRecordLine));
const fileIn = (dir, id = ID) => join(dir, journalFileName(id.runId));
const open = (dir, extra = {}) => openFileJournal({ dir, identity: ID, ...extra });
async function appendAll(j, recs) { const acks = []; for (const r of recs) acks.push(await j.journal.append(r)); return acks; }

// ---- labelled fault adapter over the module's own default adapter --------------------------------------------------------------
function faulty(plan = {}) {
  const base = createNodeFsAdapter();
  const log = { opens: [], closes: 0, writes: 0, syncs: 0, reads: 0, dirOpens: 0 };   // write / sync / read counters: JOURNAL handles only
  const wrap = (h, kind) => Object.freeze({
    write: async (buf, off, len) => {
      if (kind === "journal-open" || kind === "journal-create") {
        log.writes += 1;
        const w = plan.write && await plan.write(log.writes, { buf, off, len, base: h });   // (an async plan's null = "no fault")
        if (w) return w;
      }
      return h.write(buf, off, len);
    },
    read: async (buf, off, len, pos) => { if (!kind.startsWith("journal")) return h.read(buf, off, len, pos); log.reads += 1; const r = plan.read && await plan.read(log.reads, { buf, off, len, pos, base: h }); return r || h.read(buf, off, len, pos); },
    sync: async () => { if (kind.startsWith("journal")) { log.syncs += 1; if (plan.sync) await plan.sync(log.syncs); } return h.sync(); },
    stat: async () => h.stat(),
    close: async () => { log.closes += 1; if (plan.close && kind.startsWith("journal")) await plan.close(); return h.close(); }
  });
  const a = Object.freeze({
    realpath: base.realpath, lstat: base.lstat, unlink: base.unlink,
    open: async (p, kind) => { log.opens.push(kind); return wrap(await base.open(p, kind), kind); },
    openDir: async (p) => { log.dirOpens += 1; if (plan.dirSync) { const d = await base.openDir(p); return Object.freeze({ sync: async () => { throw plan.dirSync; }, close: d.close }); } return base.openDir(p); },
    platform: plan.platform ?? base.platform, uid: base.uid
  });
  return { a, log };
}
const gateP = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const leaksNoPath = (res, dir) => assert.ok(!JSON.stringify(res).includes(dir) && !JSON.stringify(res).includes("e7-journal-"), "no path in any result");

// =================================================================================================================================
test("F1. options / identity / fsAdapter snapshot / directory safety → code-only refusals, no path in any result", async () => {
  const d = tmp();
  let getterRuns = 0;
  const base = createNodeFsAdapter();
  const cases = [
    [undefined, "JOURNAL_OPTIONS_INVALID"], [{ dir: d }, "JOURNAL_OPTIONS_INVALID"], [{ dir: d, identity: ID, extra: 1 }, "JOURNAL_OPTIONS_INVALID"],
    [Object.defineProperty({ identity: ID }, "dir", { enumerable: true, get() { getterRuns += 1; return d; } }), "JOURNAL_OPTIONS_INVALID"],
    [new Proxy({ dir: d, identity: ID }, {}), "JOURNAL_OPTIONS_INVALID"], [{ dir: d, identity: { ...ID, runId: "BAD" } }, "IDENTITY_INVALID"],
    [{ dir: d, identity: ID, fsAdapter: { ...base, extra: 1 } }, "JOURNAL_OPTIONS_INVALID"], [{ dir: d, identity: ID, fsAdapter: new Proxy(base, {}) }, "JOURNAL_OPTIONS_INVALID"],
    [{ dir: d, identity: ID, fsAdapter: { ...base, open: new Proxy(base.open, {}) } }, "JOURNAL_OPTIONS_INVALID"],
    [{ dir: d, identity: ID, fsAdapter: Object.defineProperty({ ...base }, "lstat", { enumerable: true, get() { getterRuns += 1; return base.lstat; } }) }, "JOURNAL_OPTIONS_INVALID"],
    [{ dir: d, identity: ID, fsAdapter: { ...base, platform: "plan9" } }, "JOURNAL_PLATFORM_UNSUPPORTED"],
    [{ dir: "relative/dir", identity: ID }, "JOURNAL_DIR_INVALID"], [{ dir: `${d}\0x`, identity: ID }, "JOURNAL_DIR_INVALID"],
    [{ dir: `${d}/`, identity: ID }, "JOURNAL_DIR_INVALID"], [{ dir: `${d}/a/../`, identity: ID }, "JOURNAL_DIR_INVALID"], [{ dir: join(d, "missing"), identity: ID }, "JOURNAL_DIR_INVALID"]
  ];
  for (const [opts, code] of cases) {
    const r = await openFileJournal(opts);
    assert.deepEqual([r.ok, r.code], [false, code], JSON.stringify(code));
    leaksNoPath(r, d);
  }
  assert.equal(getterRuns, 0, "no caller getter ran");
  // symlinked directory component; a file instead of a directory; group-writable directory (POSIX)
  const real = join(d, "real"); mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(d, "link"));
  assert.equal((await open(join(d, "link"))).code, "JOURNAL_DIR_UNSAFE");
  writeFileSync(join(d, "plain"), "x");
  assert.equal((await open(join(d, "plain"))).code, "JOURNAL_DIR_UNSAFE");
  if (POSIX) { const gw = join(d, "gw"); mkdirSync(gw); chmodSync(gw, 0o770); assert.equal((await open(gw)).code, "JOURNAL_DIR_UNSAFE"); }
  assert.ok(!existsSync(fileIn(join(d, "link"))) && !existsSync(fileIn(real)), "nothing created on refusal");
});

test("F2. journal file safety: symlink / hardlink / directory / group-writable / oversize → refused; lock released, handles closed once", async () => {
  const mk = async (prep, code) => {
    const d = tmp(); prep(d);
    const f = faulty();
    const r = await open(d, { fsAdapter: f.a });
    assert.deepEqual([r.ok, r.code], [false, code]);
    assert.equal(r.cleanup, "released", "our lock removed");
    assert.ok(!existsSync(`${fileIn(d)}.lock`));
    assert.equal(f.log.closes, f.log.opens.length, "every opened handle closed exactly once");
    leaksNoPath(r, d);
  };
  await mk((d) => { writeFileSync(join(d, "target"), ""); symlinkSync(join(d, "target"), fileIn(d)); }, "JOURNAL_FILE_UNSAFE");
  await mk((d) => { writeFileSync(fileIn(d), ""); linkSync(fileIn(d), join(d, "hard")); }, "JOURNAL_FILE_UNSAFE");
  await mk((d) => { mkdirSync(fileIn(d)); }, "JOURNAL_FILE_UNSAFE");
  if (POSIX) await mk((d) => { writeFileSync(fileIn(d), ""); chmodSync(fileIn(d), 0o620); }, "JOURNAL_FILE_UNSAFE");
  await mk((d) => { writeFileSync(fileIn(d), ""); truncateSync(fileIn(d), MAX_FILE_BYTES + 1); }, "JOURNAL_TOO_LARGE");
});

test("F3. real-fs round trip: create → EMPTY; the core's record sequence acked with D.recordHash; bytes = canonical lines; fresh handle → RUN_ENDED", async () => {
  const d = tmp();
  const j = await open(d);
  assert.equal(j.ok, true, j.code);
  assert.deepEqual(Object.keys(j.journal).sort(), ["append", "read"]);
  const st0 = j.status();
  assert.deepEqual([st0.created, st0.dirSync, st0.historyValid, st0.head, st0.state], [true, POSIX ? "synced" : "unsupported", true, null, "open"]);
  const v0 = evaluateStart(await j.journal.read(), ID);
  assert.deepEqual([v0.ok, v0.code], [true, "EMPTY_JOURNAL"], "an empty file authorizes nothing beyond D's EMPTY verdict (DB P0 still required)");
  const acks = await appendAll(j, RECS);
  assert.deepEqual(acks.map((a) => [a.seq, a.hash]), RECS.map((r) => [r.seq, recordHash(r)]), "ack = { seq, D.recordHash } (not a hash of the line bytes)");
  assert.ok(acks.every(Object.isFrozen));
  assert.notEqual(acks[0].hash, (await import("node:crypto")).createHash("sha256").update(encodeRecordLine(RECS[0])).digest("hex"), "the line is not self-hashed");
  assert.equal(await codeOf(j.journal.append(RECS[0])), "CHAIN_MISMATCH");
  const c = await j.close();
  assert.deepEqual({ ...c }, { fileClose: "closed", lock: "released" });
  assert.deepEqual(readFileSync(fileIn(d)), bytesOf(RECS), "stored bytes = UTF-8 canonicalJson(record) + \\n");
  assert.ok(!existsSync(`${fileIn(d)}.lock`));
  const j2 = await open(d);
  assert.deepEqual([j2.status().created, j2.status().dirSync, j2.status().records, j2.status().head.seq], [false, "existing_not_proven", 9, 9], "reopen never claims directory persistence");
  const rr = await j2.journal.read();
  assert.deepEqual([rr.tail, rr.records.length], ["complete", 9]);
  assert.equal(evaluateStart(rr, ID).code, "RUN_ENDED");
  assert.equal(validateJournal(rr.records, ID).status, "ENDED");
  const next = validateRecord({ v: 1, seq: 10, prevHash: recordHash(RECS[8]), ...ID, at: 1, event: "RUN_STARTED" }).record;
  assert.equal(await codeOf(j2.journal.append(next)), "APPEND_AFTER_TERMINAL");
  await j2.close();
  assert.deepEqual(readFileSync(fileIn(d)), bytesOf(RECS), "a refusal never changes the file");
});

test("F4. append refusals mirror D (identity / chain / order / shape / in flight) and never change the file", async () => {
  const d = tmp();
  const j = await open(d);
  await j.journal.append(RECS[0]);
  const before = readFileSync(fileIn(d));
  const other = chain({ ...ID, runId: "synthetic-run-other" })[1];
  assert.equal(await codeOf(j.journal.append(other)), "IDENTITY_MISMATCH");
  assert.equal(await codeOf(j.journal.append(RECS[2])), "CHAIN_MISMATCH", "seq gap");
  assert.equal(await codeOf(j.journal.append({ ...RECS[1], prevHash: "b".repeat(64) })), "CHAIN_MISMATCH");
  const outOfOrder = validateRecord({ v: 1, seq: 2, prevHash: recordHash(RECS[0]), ...ID, at: 1, event: "STEP_STARTED", phase: "reservation", step: 1, factory: { phase: "reservation", reservationId: null } }).record;
  assert.equal(await codeOf(j.journal.append(outOfOrder)), "ORDER_INVALID", "STEP_STARTED before CALENDAR_BASELINE (D's own rule)");
  assert.equal(await codeOf(j.journal.append({ nope: 1 })), "RECORD_INVALID");
  assert.equal(await codeOf(j.journal.append(Object.defineProperty({ ...RECS[1] }, "event", { enumerable: true, get() { throw new Error("getter"); } }))), "RECORD_INVALID");
  assert.deepEqual(readFileSync(fileIn(d)), before);
  assert.equal(j.status().state, "open", "refusals do not poison");
  await j.journal.append(RECS[1]);
  assert.equal(MAX_LINE_BYTES, 16384); assert.equal(LOCK_BYTES, 33);
  await j.close();
});

test("F5. INJECTED write-loop faults: short writes complete ONE append; invalid bytesWritten / write / sync errors poison (no retry)", async () => {
  {   // short writes: 3 partial writes then the rest → one acknowledged append
    const d = tmp();
    const f = faulty({ write: (n, x) => (n <= 3 ? x.base.write(x.buf, x.off, Math.min(5, x.len)) : null) });
    const j = await open(d, { fsAdapter: f.a });
    await j.journal.append(RECS[0]);
    await j.close();
    assert.deepEqual(readFileSync(fileIn(d)), bytesOf([RECS[0]]));
  }
  for (const [label, bad] of [["zero", 0], ["negative", -1], ["over", 1e6], ["fractional", 1.5], ["missing", undefined]]) {
    const d = tmp();
    const f = faulty({ write: (n) => (n === 2 ? { bytesWritten: bad } : null) });
    const j = await open(d, { fsAdapter: f.a });
    await j.journal.append(RECS[0]);
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_IO_FAILED", label);
    assert.deepEqual([j.status().state, await codeOf(j.journal.append(RECS[1])), await codeOf(j.journal.read())], ["failed", "JOURNAL_FAILED", "JOURNAL_FAILED"], `${label}: poisoned`);
    assert.equal(f.log.writes, 2, `${label}: never retried`);
    await j.close();
  }
  {   // write error mid-line (half written, then EIO): partial line stays; next start sees a torn tail
    const d = tmp();
    const f = faulty({ write: async (n, x) => { if (n === 2) { await x.base.write(x.buf, x.off, 10); throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); } return null; } });
    const j = await open(d, { fsAdapter: f.a });
    await j.journal.append(RECS[0]);
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_IO_FAILED");
    await j.close();
    const j2 = await open(d);
    const rr = await j2.journal.read();
    assert.deepEqual([rr.tail, rr.records.length, evaluateStart(rr, ID).code, j2.status().historyValid], ["torn", 1, "JOURNAL_PARTIAL", false]);
    assert.equal(await codeOf(j2.journal.append(RECS[1])), "JOURNAL_HISTORY_INVALID", "never repaired / appended over");
    await j2.close();
  }
  {   // sync error: the complete line may be on disk but is NOT acknowledged; poisoned; next start refuses (RESTART_AMBIGUOUS here)
    const d = tmp();
    const f = faulty({ sync: async (n) => { if (n === 3) throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); } });   // journal syncs: 1 create, 2 append#1, 3 append#2
    const j = await open(d, { fsAdapter: f.a });
    await j.journal.append(RECS[0]);
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_IO_FAILED");
    assert.equal(j.status().head.seq, 1, "head never advanced without the sync ack");
    await j.close();
    const rr = await (await open(d)).journal.read();
    assert.deepEqual([rr.records.length, evaluateStart(rr, ID).code], [2, "RESTART_AMBIGUOUS"]);
  }
});

test("F6. timeout never proves absence: a hung append (test gate) → B guard timeout; no second append / read; close waits; late landing is the only record", async () => {
  const d = tmp();
  const g = gateP();
  const f = faulty({ write: async (n, x) => { if (n === 2) { await g.p; return x.base.write(x.buf, x.off, x.len); } return null; } });
  const j = await open(d, { fsAdapter: f.a });
  await j.journal.append(RECS[0]);
  const gd = validateGuardDeps({ monotonic: () => performance.now(), timers: { arm: (ms) => { let h; const promise = new Promise((r) => { h = setTimeout(r, ms); }); return { promise, cancel: () => clearTimeout(h) }; } } });
  const guard = createGuard(gd.deps);
  const pending = j.journal.append(RECS[1]);
  assert.ok(isNativePromise(pending), "append returns an unpatched native promise (B)");
  const r = await guard.observe(performance.now() + 50, () => pending);
  assert.equal(r.kind, "timeout", "the core's observation times out");
  assert.equal(await codeOf(j.journal.append(RECS[1])), "APPEND_IN_FLIGHT", "no second append with the same seq");
  assert.equal(await codeOf(j.journal.read()), "JOURNAL_BUSY", "no read of a half-written append");
  const cp = j.close();
  assert.equal(j.close(), cp, "close = one memoized promise");
  assert.ok(isNativePromise(cp));
  assert.equal(await codeOf(j.journal.read()), "JOURNAL_CLOSED", "new operations rejected immediately once closing");
  assert.equal((await settledWithin(cp, 150)).settled, false, "close waits for the started append (no timer / force close)");
  assert.ok(existsSync(`${fileIn(d)}.lock`), "the lock is not taken away from an in-flight append");
  g.release();
  const ack = await pending;
  assert.equal(ack.seq, 2, "the late append landed (and was acknowledged to nobody)");
  const c = await cp;
  assert.deepEqual({ ...c }, { fileClose: "closed", lock: "released" });
  assert.deepEqual(readFileSync(fileIn(d)), bytesOf(RECS.slice(0, 2)), "exactly one landed record, no duplicate");
  assert.equal(f.log.closes, f.log.opens.length);
});

test("F7. read / close races: close waits for an in-flight READ; append during a read is refused; close failures are observable, never rejected", async () => {
  const d = tmp();
  const g = gateP();
  let hold = false;
  const f = faulty({ read: async (n, x) => { if (hold) { await g.p; } return null; }, close: async () => { throw Object.assign(new Error("synthetic"), { code: "EIO" }); } });
  const j = await open(d, { fsAdapter: f.a });
  await j.journal.append(RECS[0]);
  hold = true;
  const rp = j.journal.read();
  await sleep(20);
  assert.equal(await codeOf(j.journal.append(RECS[1])), "APPEND_IN_FLIGHT", "no append begins during a re-read");
  const cp = j.close();
  assert.equal((await settledWithin(cp, 100)).settled, false, "close waits for the started read");
  hold = false; g.release();
  assert.equal((await rp).records.length, 1);
  const c = await cp;
  assert.deepEqual({ ...c }, { fileClose: "failed", lock: "released" }, "file close failure reported code-only; lock still released once");
  assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_CLOSED");
});

test("F8. path vs fd identity: external append / same-size rewrite / pathname replacement → JOURNAL_FILE_CHANGED (poison), never stale-cache acceptance", async () => {
  {   // external append through another descriptor
    const d = tmp(); const j = await open(d); await j.journal.append(RECS[0]);
    appendFileSync(fileIn(d), "x");
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_FILE_CHANGED");
    assert.equal(j.status().state, "failed"); await j.close();
  }
  {   // same-size in-place rewrite is caught by the byte comparison on read
    const d = tmp(); const j = await open(d); await j.journal.append(RECS[0]);
    const b = readFileSync(fileIn(d)); b[b.length - 3] = b[b.length - 3] === 0x31 ? 0x32 : 0x31;
    const fd = openSync(fileIn(d), "r+"); try { (await import("node:fs")).writeSync(fd, b, 0, b.length, 0); } finally { closeSync(fd); }
    assert.equal(await codeOf(j.journal.read()), "JOURNAL_FILE_CHANGED");
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_FAILED"); await j.close();
  }
  {   // pathname replacement: the fd still points at the old inode; the PATH check refuses
    const d = tmp(); const j = await open(d); await j.journal.append(RECS[0]);
    renameSync(fileIn(d), join(d, "moved")); writeFileSync(fileIn(d), readFileSync(join(d, "moved")));
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_FILE_CHANGED");
    assert.deepEqual(readFileSync(fileIn(d)), bytesOf([RECS[0]]), "the replacement file is untouched");
    await j.close();
  }
  {   // size change DURING a read (INJECTED: an external append between the bounded read and its probe)
    const d = tmp();
    let arm = false;
    const f = faulty({ read: (n, x) => { if (arm && x.pos === 0) { arm = false; appendFileSync(fileIn(d), "y"); } return null; } });
    const j = await open(d, { fsAdapter: f.a }); await j.journal.append(RECS[0]);
    arm = true;
    assert.equal(await codeOf(j.journal.read()), "JOURNAL_FILE_CHANGED", "growth during the read is detected (bounded read + probe)");
    await j.close();
  }
});

test("F9. bounded hostile parsing: torn tail vs corrupt lines; canonical-but-invalid records go to D; every case refuses start + append and keeps bytes", async () => {
  const good = bytesOf(RECS.slice(0, 2));
  const line0 = encodeRecordLine(RECS[0]).toString("utf8").trimEnd();
  const cases = [
    ["torn tail", Buffer.concat([good, Buffer.from(line0.slice(0, 20))]), "torn", "JOURNAL_PARTIAL"],
    ["torn mid multi-byte sequence", Buffer.concat([good, Buffer.from([0x7b, 0xe2, 0x82])]), "torn", "JOURNAL_PARTIAL"],
    ["invalid UTF-8 complete line", Buffer.concat([good, Buffer.from([0x7b, 0xff, 0x7d, 0x0a])]), "corrupt"],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), "corrupt"],
    ["CRLF", Buffer.from(good.toString("utf8").replace(/\n/g, "\r\n")), "corrupt"],
    ["empty line", Buffer.concat([good, Buffer.from("\n")]), "corrupt"],
    ["not JSON", Buffer.concat([good, Buffer.from("hello\n")]), "corrupt"],
    ["non-canonical whitespace", Buffer.from(`${JSON.stringify(RECS[0], null, 1).replace(/\n/g, "")}\n`), "corrupt"],
    ["duplicate keys", Buffer.from(`${line0.replace('{"at":', '{"at":0,"at":')}\n`), "corrupt"],
    ["deep nesting", Buffer.from(`${"[".repeat(5000)}${"]".repeat(5000)}\n`), "corrupt"],
    ["unsafe integer", Buffer.from(`${line0.replace(/"at":\d+/, '"at":1e400')}\n`), "corrupt"],
    ["huge string line", Buffer.from(`"${"a".repeat(MAX_LINE_BYTES)}"\n`), "corrupt"],
    ["__proto__ own key (canonical bytes) → D", Buffer.from(`${canonicalJson(JSON.parse(`{"__proto__":1,${line0.slice(1)}`))}\n`), "d", "JOURNAL_MALFORMED"],
    ["middle field change", Buffer.concat([encodeRecordLine({ ...RECS[0], at: 7 }), encodeRecordLine(RECS[1])]), "d", "JOURNAL_CHAIN_INVALID"],
    ["swapped lines", bytesOf([RECS[1], RECS[0]]), "d", "JOURNAL_CHAIN_INVALID"],
    ["foreign identity", bytesOf(chain({ ...ID, intentId: "00000000-0000-4000-8000-0000000000f2" }).slice(0, 2)), "d", "MANIFEST_MISMATCH"],
    ["duplicate terminal", bytesOf(chain(ID, [...BODIES, BODIES[8]])), "d", "JOURNAL_MALFORMED"]
  ];
  for (const [label, bytes, kind, dcode] of cases) {
    const d = tmp(); writeFileSync(fileIn(d), bytes, { mode: 0o600 });
    const j = await open(d);
    assert.equal(j.ok, true, `${label}: a safe file opens so the core can refuse with D's codes (${j.code})`);
    assert.equal(j.status().historyValid, false, label);
    const r1 = await j.journal.read().then((v) => ({ v }), (e) => ({ e }));
    if (kind === "corrupt") {
      assert.equal(r1.e && r1.e.code, "JOURNAL_CORRUPT", label);
      assert.equal(await codeOf(j.journal.read()), "JOURNAL_CORRUPT", `${label}: consistent on re-read, not a poison`);
      assert.equal(j.status().state, "open");
    } else {
      const v = evaluateStart(r1.v, ID);
      assert.equal(v.ok, false, `${label}: start refused`);
      if (dcode) assert.equal(v.code, dcode, label);
      if (kind === "torn") assert.equal(r1.v.tail, "torn", label);
    }
    assert.equal(await codeOf(j.journal.append(RECS[2])), "JOURNAL_HISTORY_INVALID", `${label}: append refused`);
    await j.close();
    assert.deepEqual(readFileSync(fileIn(d)), bytes, `${label}: bytes never modified`);
  }
  // pure parser bounds
  assert.deepEqual(parseJournalBytes(Buffer.from(Array.from({ length: 1025 }, () => "1\n").join(""))).code, "JOURNAL_TOO_LARGE");
  assert.equal(parseJournalBytes("not bytes").code, "JOURNAL_CORRUPT");
});

test("F10. lock ownership: second open LOCKED; close removes only OUR lock; replaced / symlinked / altered lock is never removed; stale lock never broken", async () => {
  const d = tmp();
  const j = await open(d);
  assert.equal((await open(d)).code, "JOURNAL_LOCKED");
  const lock = `${fileIn(d)}.lock`;
  // replace our lock with another regular file (same size, other nonce)
  unlinkSync(lock); writeFileSync(lock, `${"0".repeat(32)}\n`, { mode: 0o600 });
  assert.deepEqual({ ...(await j.close()) }, { fileClose: "closed", lock: "not_owned" });
  assert.equal(readFileSync(lock, "utf8"), `${"0".repeat(32)}\n`, "another owner's lock is untouched");
  assert.equal((await open(d)).code, "JOURNAL_LOCKED", "a stale / foreign lock is never broken automatically");
  unlinkSync(lock);                                                      // the TEST removes its own artifact explicitly
  const j2 = await open(d);
  const target = join(d, "target"); writeFileSync(target, "keep\n");
  unlinkSync(lock); symlinkSync(target, lock);
  assert.equal((await j2.close()).lock, "not_owned", "a symlinked lock is never followed or removed");
  assert.equal(readFileSync(target, "utf8"), "keep\n");
  unlinkSync(lock);
  const j3 = await open(d);
  assert.equal((await j3.close()).lock, "released");
  assert.ok(!existsSync(lock));
});

test("F11. directory-sync classification: POSIX permission / IO failure fails CLOSED; win32 is a deliberate 'unsupported'; no dir sync on reopen", async () => {
  for (const code of ["EPERM", "EINVAL", "EIO"]) {
    const d = tmp();
    const f = faulty({ platform: "linux", dirSync: Object.assign(new Error("synthetic"), { code }) });
    const r = await open(d, { fsAdapter: f.a });
    assert.deepEqual([r.ok, r.code, r.cleanup], [false, "JOURNAL_DIR_SYNC_FAILED", "released"], `${code} on POSIX is never 'unsupported'`);
    assert.equal(f.log.closes, f.log.opens.length);
  }
  const d = tmp();
  const f = faulty({ platform: "win32" });
  const j = await open(d, { fsAdapter: f.a });
  assert.deepEqual([j.ok, j.status().dirSync, f.log.dirOpens], [true, "unsupported", 0]);
  await j.close();
  const f2 = faulty();
  const j2 = await open(d, { fsAdapter: f2.a });
  assert.deepEqual([j2.status().dirSync, f2.log.dirOpens], ["existing_not_proven", 0]);
  await j2.close();
});

test("F12. CRASH (child process SIGKILLed mid-write): stale lock refuses until the test removes it; then torn tail → JOURNAL_PARTIAL; bytes never repaired", () => {
  const d = tmp();
  const recJson = JSON.stringify(RECS.slice(0, 2));
  const child = `
    import { openFileJournal, createNodeFsAdapter } from ${JSON.stringify(pathToFileURL(MOD).href)};
    const base = createNodeFsAdapter(); let n = 0;
    const open = async (p, kind) => { const h = await base.open(p, kind); return Object.freeze({ ...h, write: async (b, o, l) => {
      if (kind !== "journal-create") return h.write(b, o, l);
      n += 1; if (n === 2) { await h.write(b, o, Math.floor(l / 2)); process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); }
      return h.write(b, o, l); } }); };
    const j = await openFileJournal({ dir: ${JSON.stringify(d)}, identity: ${JSON.stringify(ID)}, fsAdapter: Object.freeze({ ...base, open }) });
    const recs = ${recJson};
    for (const r of recs) await j.journal.append(r);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], { timeout: 20_000, encoding: "utf8" });
  assert.equal(r.signal, "SIGKILL", `child killed mid-write (status ${r.status}, ${String(r.stderr).slice(0, 200)})`);
  const lock = `${fileIn(d)}.lock`;
  assert.ok(existsSync(lock), "the dead process left its lock");
  const bytes = readFileSync(fileIn(d));
  return (async () => {
    assert.equal((await open(d)).code, "JOURNAL_LOCKED", "stale lock: refused, never auto-broken");
    unlinkSync(lock);                                                    // explicit removal of the test's own stale lock
    const j = await open(d);
    const rr = await j.journal.read();
    assert.deepEqual([rr.tail, rr.records.length, evaluateStart(rr, ID).code], ["torn", 1, "JOURNAL_PARTIAL"]);
    assert.equal(await codeOf(j.journal.append(RECS[1])), "JOURNAL_HISTORY_INVALID");
    await j.close();
    assert.deepEqual(readFileSync(fileIn(d)), bytes, "torn bytes kept as found");
  })();
});

test("F13. core-interface compatibility (no PG): getter-free data methods, native promises, D read shape, B guard observation", async () => {
  const d = tmp();
  const j = await open(d);
  for (const k of ["append", "read"]) { const desc = Object.getOwnPropertyDescriptor(j.journal, k); assert.ok("value" in desc && typeof desc.value === "function"); }
  assert.ok(Object.isFrozen(j.journal));
  const rp = j.journal.read(); assert.ok(isNativePromise(rp));
  const rr = await rp;
  assert.deepEqual(Object.keys(rr).sort(), ["records", "tail"]);
  assert.equal(evaluateStart(rr, ID, { trustedHead: { seq: 0, hash: GENESIS_HASH } }).anchored, true, "an OUT-OF-BAND trusted head is passed to D unchanged");
  const bad = j.journal.append({}); assert.ok(isNativePromise(bad)); await bad.catch(() => {});
  const gd = validateGuardDeps({ monotonic: () => performance.now(), timers: { arm: (ms) => { let h; const promise = new Promise((r) => { h = setTimeout(r, ms); }); return { promise, cancel: () => clearTimeout(h) }; } } });
  const guard = createGuard(gd.deps);
  const o = await guard.observe(performance.now() + 2000, () => j.journal.append(RECS[0]));
  assert.deepEqual([o.kind, o.value.seq, o.value.hash], ["fulfilled", 1, recordHash(RECS[0])], "exactly the ack the core checks (run-core.mjs:259–260)");
  await j.close();
});

test("F14. source pins: exact imports; no timers / env / network / child process / SDK / core / worker import; process only in the default adapter", () => {
  const src = readFileSync(MOD, "utf8");
  const imports = [...src.matchAll(/^import\s.*?from\s+"([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./run-journal-memory.mjs", "./run-manifest.mjs", "node:crypto", "node:fs", "node:fs/promises", "node:path", "node:util"]);
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/setTimeout|setInterval|setImmediate/, /process\.env/, /\bfetch\s*\(/, /child_process|node:net|node:https?/, /run-core|lib\/booking-db|executor-adapters|stripe|hostaway/i,
    /\btruncate|ftruncate|rename\(|rmSync|rm\(/]) assert.doesNotMatch(code, re, String(re));
  assert.deepEqual([...code.matchAll(/process\.[a-zA-Z]+/g)].map((m) => m[0]).sort(), ["process.getuid", "process.getuid", "process.platform"], "process only for the default adapter's platform / uid");
  assert.equal(netAttempts, 0);
});
