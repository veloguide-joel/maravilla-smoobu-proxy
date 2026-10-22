// E4 write runner journal — short/zero/invalid write progress (QC 2026-10-22, defect 2). Separate file because
// these tests patch node:fs (syncBuiltinESMExports) and must not leak into other tests. Offline; synthetic.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileJournal, readJournalFile, JournalError } from "../scripts/e4-write-runner/journal.mjs";
import { validateManifest, executeRun } from "../scripts/e4-write-runner/runner.mjs";

const realWrite = fs.writeSync;
const realFsync = fs.fsyncSync;
const patch = (writeSync, fsyncSync = realFsync) => { fs.writeSync = writeSync; fs.fsyncSync = fsyncSync; syncBuiltinESMExports(); };
afterEach(() => patch(realWrite, realFsync));

const HASH = "a".repeat(64);
const tmp = () => mkdtempSync(join(tmpdir(), "e4-journal-"));
const ENTRY = { type: "intent", step: "W1_CREATE_R2", kind: "create", ref: "MV-ABCDEFGH" };

test("short positive writes: the loop completes the entry; fsync runs once, only after the last byte", { timeout: 5000 }, () => {
  const j = createFileJournal(tmp(), HASH);
  const calls = [];
  patch((fd, buf, off, len) => { const n = Math.min(len, 5); calls.push(["write", n]); return realWrite(fd, buf, off, n); },
    (fd) => { calls.push(["fsync"]); return realFsync(fd); });
  j.append(ENTRY);
  patch(realWrite, realFsync);
  const line = `${JSON.stringify(ENTRY)}\n`;
  assert.ok(calls.filter((c) => c[0] === "write").length > 5, "many short writes");
  assert.deepEqual(calls.at(-1), ["fsync"]);
  assert.equal(calls.filter((c) => c[0] === "fsync").length, 1);
  assert.equal(readFileSync(j.path, "utf8"), line);
  assert.deepEqual(j.load(), [ENTRY]);
  assert.deepEqual(readJournalFile(j.path), [ENTRY]);
});

test("multi-byte UTF-8 is written by byte length, not character length", { timeout: 5000 }, () => {
  const j = createFileJournal(tmp(), HASH);
  patch((fd, buf, off, len) => realWrite(fd, buf, off, Math.min(len, 3)));
  j.append({ type: "run-start", note: "señal ✓" });
  patch(realWrite);
  assert.equal(readFileSync(j.path, "utf8"), `${JSON.stringify({ type: "run-start", note: "señal ✓" })}\n`);
});

for (const [name, ret] of [["zero", 0], ["negative", -1], ["non-integer", 2.5], ["NaN", Number.NaN], ["undefined", undefined],
  ["beyond the remaining length", 1e6]]) {
  test(`${name} write progress fails the append: nothing mirrored, no fsync, journal permanently failed`, { timeout: 5000 }, () => {
    const j = createFileJournal(tmp(), HASH);
    let fsyncs = 0;
    patch(() => ret, () => { fsyncs++; });
    assert.throws(() => j.append(ENTRY), (e) => e instanceof JournalError && e.code === "JOURNAL_WRITE_INCOMPLETE");
    patch(realWrite, realFsync);
    assert.equal(fsyncs, 0);
    assert.deepEqual(j.load(), []);
    assert.throws(() => j.append(ENTRY), (e) => e.code === "JOURNAL_FAILED", "no automatic retry");
  });
}

test("a thrown write error propagates as JOURNAL_WRITE_FAILED; a failed fsync also fails the append", { timeout: 5000 }, () => {
  let j = createFileJournal(tmp(), HASH);
  patch(() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); });
  assert.throws(() => j.append(ENTRY), (e) => e.code === "JOURNAL_WRITE_FAILED");
  patch(realWrite);
  assert.deepEqual(j.load(), []);
  j = createFileJournal(tmp(), HASH);
  patch(realWrite, () => { throw new Error("fsync failed"); });
  assert.throws(() => j.append(ENTRY), (e) => e.code === "JOURNAL_WRITE_FAILED");
  patch(realWrite, realFsync);
  assert.deepEqual(j.load(), [], "not mirrored without a successful fsync");
});

test("a partial entry is preserved (never truncated or deleted) and reads back as JOURNAL_CORRUPT", { timeout: 5000 }, () => {
  const j = createFileJournal(tmp(), HASH);
  j.append({ type: "run-start" });
  const before = statSync(j.path).size;
  let n = 0;
  patch((fd, buf, off, len) => (++n === 1 ? realWrite(fd, buf, off, 7) : 0));
  assert.throws(() => j.append(ENTRY), (e) => e.code === "JOURNAL_WRITE_INCOMPLETE");
  patch(realWrite);
  assert.equal(statSync(j.path).size, before + 7, "partial bytes kept");
  assert.throws(() => readJournalFile(j.path), (e) => e.code === "JOURNAL_CORRUPT");
  assert.throws(() => createFileJournal(j.path.replace(/\/[^/]+$/, ""), HASH), (e) => e.code === "JOURNAL_EXISTS", "never reused");
});

test("execute: if W1's intent cannot be written completely, W1 is never dispatched", { timeout: 5000 }, async () => {
  const NOW = () => new Date("2026-10-22T18:00:00.000Z");
  const manifest = {
    manifestVersion: "e4-write-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000,
    cleaningFeeMinor: 5000, guests: 2, window: { start: "2027-03-01", end: "2027-03-15" },
    r1Block: { arrivalDate: "2027-03-10", departureDate: "2027-03-12" }, r2Stay: { arrivalDate: "2027-03-03", departureDate: "2027-03-05" },
    x1bOverlap: { arrivalDate: "2027-03-04", departureDate: "2027-03-06" },
    guest: { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" }
  };
  const v = validateManifest(manifest, { now: NOW });
  const log = [];
  const transport = { send: async (req) => {
    log.push(req);
    if (req.method === "POST" && /priceDetails$/.test(req.path)) return { httpStatus: 200, json: { status: "success", result: { totalPrice: 250 } } };
    if (req.method === "GET" && req.path === "/reservations") return { httpStatus: 200, json: { status: "success", result: [] } };
    return { httpStatus: 500, json: {} };
  } };
  const journal = createFileJournal(tmp(), v.hash);
  // Every write of an intent entry makes zero progress; all other entries are written normally.
  patch((fd, buf, off, len) => (buf.toString("utf8").includes('"type":"intent"') ? 0 : realWrite(fd, buf, off, len)));
  const report = await executeRun({ mode: "execute", manifest, confirm: v.confirmToken, transport, journal,
    sideEffectProbe: async () => ({ signals: [] }), now: NOW, timeoutMs: 50 });
  patch(realWrite);
  assert.equal(report.status, "HALTED");
  assert.equal(report.halt.code, "JOURNAL_WRITE_FAILED");
  assert.equal(report.halt.step, "W1_CREATE_R2");
  assert.ok(!log.some((r) => r.method === "POST" && r.path === "/reservations"), "W1 never sent");
  assert.ok(log.every((r) => r.method === "GET" || /priceDetails$/.test(r.path)));
  assert.equal(journal.load().filter((e) => e.type === "intent").length, 0);
});
