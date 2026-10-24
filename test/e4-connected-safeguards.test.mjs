// E4 connected-listing safeguard primitives — offline, synthetic inputs only (NOT provider evidence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { nightsState, observeSync, evaluateCreateSideEffects, realTimer } = await import("../scripts/e4-connected/safeguards.mjs");
import { spawnSync } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname;
const N = ["2030-01-10", "2030-01-11"];                     // invented dates, no real listing
const cal = (status, isAvailable, nights = N) => ({ httpStatus: 200, json: { status: "success", result: nights.map((date) => ({ date, status, isAvailable })) } });

test("nightsState: blocked / open / mixed / unknown for exactly the given nights", () => {
  assert.equal(nightsState(cal("reserved", 0), N), "blocked");
  assert.equal(nightsState(cal("blocked", false), N), "blocked");
  assert.equal(nightsState(cal("available", 1), N), "open");
  assert.equal(nightsState({ httpStatus: 200, json: { status: "success", result: [{ date: N[0], status: "reserved", isAvailable: 0 }, { date: N[1], status: "available", isAvailable: 1 }] } }, N), "mixed");
  for (const r of [cal("available", 0), cal("reserved", 1), cal("weird", 0), cal("available", 1, [N[0]]), { transportError: true }, { httpStatus: 500 },
    { httpStatus: 200, json: { status: "fail" } }, cal("available", null)]) assert.equal(nightsState(r, N), "unknown", JSON.stringify(r));
  const dup = cal("available", 1, [N[0], N[0], N[1]]);
  assert.equal(nightsState(dup, N), "unknown", "duplicate day is unknown");
});

// Virtual clock: time advances ONLY when nothing else can run and the earliest pending timer fires (like real timers).
// Losing timers of a race stay pending and fire harmlessly later, exactly as real setTimeout-based sleeps would.
function vclock() {
  let t = 0; let timers = [];
  const sleep = (ms) => new Promise((r) => timers.push({ due: t + ms, r }));
  const startTimer = (ms) => { let entry; const promise = new Promise((r) => { entry = { due: t + ms, r }; timers.push(entry); });
    return { promise, cancel: () => { timers = timers.filter((x) => x !== entry); entry.r(); } }; };
  async function drive(promise) {
    let done = false, val;
    promise.then((v) => { done = true; val = v; });
    for (let guard = 0; guard < 10000; guard++) {
      await new Promise((r) => setImmediate(r));
      if (done) return val;
      if (!timers.length) throw new Error("deadlock: nothing pending");
      timers.sort((a, b) => a.due - b.due);
      const x = timers.shift(); t = Math.max(t, x.due); x.r();
    }
    throw new Error("driver guard");
  }
  return { sleep, startTimer, now: () => t, drive, advance: (ms) => { t += ms; }, pending: () => timers.length };
}
const opts = (clk, read, over = {}) => ({ readCalendar: read, nights: N, expect: "blocked", intervalMs: 60000, timeoutMs: 600000, maxReads: 20, confirmReads: 2,
  startTimer: clk.startTimer, now: clk.now, ...over });
const seqReader = (seq) => { let i = 0; return async () => { const r = seq[Math.min(i, seq.length - 1)]; i++; if (r === "throw") throw new Error("x"); return r; }; };
const runObs = async (seq, over = {}) => { const clk = vclock(); return clk.drive(observeSync(opts(clk, seqReader(seq), over))); };

test("observeSync: needs N consecutive confirming reads; flapping/unknown reset; timeout and read cap never conclude", async () => {
  let r = await runObs([cal("available", 1), cal("reserved", 0), cal("reserved", 0)]);
  assert.deepEqual([r.code, r.reads, r.history, r.observedAfterMs], ["OBSERVED_STABLE", 3, ["open", "blocked", "blocked"], 120000]);
  r = await runObs([cal("reserved", 0), "throw", cal("reserved", 0), cal("reserved", 0)]);
  assert.deepEqual([r.code, r.history], ["OBSERVED_STABLE", ["blocked", "unknown", "blocked", "blocked"]]);
  r = await runObs([cal("available", 1)], { timeoutMs: 180000 });
  assert.deepEqual([r.code, r.reads], ["TIMEOUT", 3], "reads at 0/60/120 s; a read at 180 s would start at the deadline");
  r = await runObs([cal("available", 1)], { maxReads: 4 });
  assert.deepEqual([r.code, r.reads], ["READ_CAP_REACHED", 4]);
  r = await runObs([cal("reserved", 0), cal("available", 1), cal("reserved", 0), cal("available", 1)], { maxReads: 4 });
  assert.equal(r.code, "READ_CAP_REACHED", "flapping never confirms");
  r = await runObs([cal("available", 1), cal("available", 1)], { expect: "open" });
  assert.deepEqual([r.code, r.reads], ["OBSERVED_STABLE", 2]);
  for (const over of [{ nights: [] }, { nights: ["2030-1-1"] }, { nights: [N[0], N[0]] }, { expect: "maybe" }, { intervalMs: 10 }, { timeoutMs: 999999999 },
    { maxReads: 0 }, { maxReads: 500 }, { confirmReads: 0 }, { startTimer: null }, { readCalendar: null }]) {
    const clk = vclock();
    assert.equal((await observeSync(opts(clk, seqReader([cal("reserved", 0)]), over))).code, "INVALID_OPTIONS", JSON.stringify(over));
  }
});

test("observeSync deadline: a late success never counts; a never-resolving read times out; no read starts at/after the deadline", async () => {
  // root's reproduction: interval 1 s, timeout 1 s, confirmReads 1, the read itself takes the clock to 2 s and returns blocked
  let clk = vclock();
  let r = await clk.drive(observeSync(opts(clk, async () => { clk.advance(2000); return cal("reserved", 0); }, { intervalMs: 1000, timeoutMs: 1000, confirmReads: 1, maxReads: 2 })));
  assert.deepEqual([r.code, r.reads, r.history], ["TIMEOUT", 1, []]);
  // a read that never settles: bounded by the deadline, its (absent) result never counts
  clk = vclock(); let started = 0;
  r = await clk.drive(observeSync(opts(clk, () => { started++; return new Promise(() => {}); }, { intervalMs: 1000, timeoutMs: 5000, confirmReads: 1 })));
  assert.deepEqual([r.code, r.reads, started, clk.now()], ["TIMEOUT", 1, 1, 5000]);
  // a slow read that settles in time counts; one that settles exactly at the deadline does not
  clk = vclock();
  r = await clk.drive(observeSync(opts(clk, () => clk.sleep(500).then(() => cal("reserved", 0)), { intervalMs: 1000, timeoutMs: 5000, confirmReads: 1 })));
  assert.deepEqual([r.code, r.observedAfterMs], ["OBSERVED_STABLE", 500]);
  clk = vclock();
  r = await clk.drive(observeSync(opts(clk, () => clk.sleep(5000).then(() => cal("reserved", 0)), { intervalMs: 1000, timeoutMs: 5000, confirmReads: 1 })));
  assert.equal(r.code, "TIMEOUT");
  // second read would be slow and cross the deadline: the first (blocked) read alone does not confirm with confirmReads 2
  clk = vclock(); let k = 0;
  r = await clk.drive(observeSync(opts(clk, () => (++k === 1 ? Promise.resolve(cal("reserved", 0)) : clk.sleep(10000).then(() => cal("reserved", 0))),
    { intervalMs: 1000, timeoutMs: 5000, confirmReads: 2 })));
  assert.deepEqual([r.code, r.history], ["TIMEOUT", ["blocked"]]);
  // reads never start at/after the deadline
  clk = vclock(); const startTimes = [];
  r = await clk.drive(observeSync(opts(clk, async () => { startTimes.push(clk.now()); return cal("available", 1); }, { intervalMs: 2000, timeoutMs: 6000, maxReads: 20 })));
  assert.equal(r.code, "TIMEOUT");
  assert.ok(startTimes.every((x) => x < 6000), JSON.stringify(startTimes));
  assert.deepEqual(startTimes, [0, 2000, 4000]);
  assert.equal(clk.now(), 4000, "returns as soon as the next read could not start before the deadline (no idle wait)");
  // an interval wait that overshoots (late timer / suspended machine): no read may start after the deadline has passed
  clk = vclock(); let begun = 0;
  const lateInterval = (ms) => (ms === 1000 ? clk.startTimer(7000) : clk.startTimer(ms));
  r = await clk.drive(observeSync({ ...opts(clk, async () => { begun++; return cal("available", 1); }, { intervalMs: 1000, timeoutMs: 5000 }), startTimer: lateInterval }));
  assert.deepEqual([r.code, r.reads, begun], ["TIMEOUT", 1, 1]);
});

test("observeSync timers: every deadline timer is cancelled after its race (none left pending, none accumulated)", async () => {
  let clk = vclock();
  let r = await clk.drive(observeSync(opts(clk, seqReader([cal("available", 1)]), { maxReads: 20, timeoutMs: 3600000 })));
  assert.deepEqual([r.code, r.reads, clk.pending()], ["READ_CAP_REACHED", 20, 0]);
  clk = vclock();
  r = await clk.drive(observeSync(opts(clk, seqReader([cal("reserved", 0)]), { confirmReads: 1 })));
  assert.deepEqual([r.code, clk.pending()], ["OBSERVED_STABLE", 0]);
});

const activeTimeouts = () => process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
test("observeSync with REAL timers: fast success leaves no timer behind; a never-resolving read times out at the deadline", async () => {
  const before = activeTimeouts();
  let t0 = Date.now();
  let r = await observeSync({ readCalendar: async () => cal("reserved", 0), nights: N, expect: "blocked", intervalMs: 1000, timeoutMs: 60000, maxReads: 3,
    confirmReads: 1, startTimer: realTimer, now: Date.now });
  assert.equal(r.code, "OBSERVED_STABLE");
  assert.ok(Date.now() - t0 < 1000, "fast");
  assert.equal(activeTimeouts(), before, "the 60 s deadline timer was cancelled");
  t0 = Date.now();
  r = await observeSync({ readCalendar: () => new Promise(() => {}), nights: N, expect: "blocked", intervalMs: 1000, timeoutMs: 1000, maxReads: 3,
    confirmReads: 1, startTimer: realTimer, now: Date.now });
  const el = Date.now() - t0;
  assert.equal(r.code, "TIMEOUT");
  assert.ok(el >= 950 && el < 3000, `elapsed ${el}`);
  assert.equal(activeTimeouts(), before, "no timer left after the timeout");
});

test("liveness: a process using observeSync with a 60 s deadline exits right after an early success", () => {
  const mod = new URL("../scripts/e4-connected/safeguards.mjs", import.meta.url).href;
  const code = `const { observeSync, realTimer } = await import(${JSON.stringify(mod)});
    const day = (date) => ({ date, status: "reserved", isAvailable: 0 });
    const r = await observeSync({ readCalendar: async () => ({ httpStatus: 200, json: { status: "success", result: [day("2030-01-10"), day("2030-01-11")] } }),
      nights: ["2030-01-10", "2030-01-11"], expect: "blocked", intervalMs: 1000, timeoutMs: 60000, maxReads: 5, confirmReads: 1, startTimer: realTimer, now: Date.now });
    process.stdout.write(r.code);`;
  const t0 = Date.now();
  const ex = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
  assert.deepEqual([ex.status, ex.stdout], [0, "OBSERVED_STABLE"]);
  assert.ok(Date.now() - t0 < 10000, `exited in ${Date.now() - t0} ms (a leaked 60 s timer would hold it open)`);
});

test("evaluateCreateSideEffects: only charges complete-zero + tasks complete-empty + exactly one complete conversation is acceptable", () => {
  const c = (ids, state = "complete") => ({ state, code: "X", ids });
  assert.deepEqual(evaluateCreateSideEffects({ charges: "zero", conversations: c([77]), tasks: c([]) }),
    { ok: true, code: "EXPECTED_SINGLE_CONVERSATION_ONLY", conversationId: 77, messagesObservable: false });
  const bad = [
    [{ charges: "present", conversations: c([77]), tasks: c([]) }, "CHARGES_PRESENT"], [{ charges: "unknown", conversations: c([77]), tasks: c([]) }, "CHARGES_UNKNOWN"],
    [{ charges: "zero", conversations: { state: "unknown", code: "X" }, tasks: c([]) }, "CONVERSATIONS_UNKNOWN"],
    [{ charges: "zero", conversations: c([77]), tasks: { state: "unknown" } }, "TASKS_UNKNOWN"],
    [{ charges: "zero", conversations: c([77]), tasks: c([5]) }, "TASKS_PRESENT"],
    [{ charges: "zero", conversations: c([]), tasks: c([]) }, "EXPECTED_CONVERSATION_ABSENT"],
    [{ charges: "zero", conversations: c([77, 78]), tasks: c([]) }, "MORE_THAN_ONE_CONVERSATION"], [{}, "CHARGES_UNKNOWN"]
  ];
  for (const [input, code] of bad) assert.deepEqual(evaluateCreateSideEffects(input), { ok: false, code }, code);
});

test("containment: no listing/currency/channel constants, no I/O; only the cancel-only recovery imports it (read-only calendar observation)", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-connected/safeguards.mjs"), "utf8");
  for (const re of [/60\d{4}/, /\b(USD|MXN)\b/, /airbnb\.com|rooms\//i, /\bimport\b/, /fetch\(|process\.env|console\.|writeFileSync|readFileSync/]) assert.doesNotMatch(src, re, String(re));
  const walk = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(p, e.name))) : [join(p, e.name)]);
  // Only IMPORTS count (a provenance list naming the path, as in precheck's PRECHECK_SOURCES, is not an import).
  const importers = [...walk("api"), ...walk("lib"), ...walk("scripts")].filter((f) => !f.endsWith("safeguards.mjs") &&
    /(from\s*|import\s*\(\s*)["'][^"']*e4-connected/.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(importers.map((f) => f.replace(/\\/g, "/")), ["scripts/e4-recovery/cancel-only.mjs"]);
  assert.match(readFileSync(join(ROOT, "scripts/e4-recovery/cancel-only.mjs"), "utf8"), /^import \{ observeSync, realTimer \} from "\.\.\/e4-connected\/safeguards\.mjs";$/m);
});
