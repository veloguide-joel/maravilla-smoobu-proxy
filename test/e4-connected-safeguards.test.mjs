// E4 connected-listing safeguard primitives — offline, synthetic inputs only (NOT provider evidence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const { nightsState, observeSync, evaluateCreateSideEffects } = await import("../scripts/e4-connected/safeguards.mjs");
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

function clock() { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; }
const base = (seq, over = {}) => { const c = clock(); let i = 0;
  return { readCalendar: async () => { const r = seq[Math.min(i, seq.length - 1)]; i++; if (r === "throw") throw new Error("x"); return r; },
    nights: N, expect: "blocked", intervalMs: 60000, timeoutMs: 600000, maxReads: 20, confirmReads: 2, ...c, ...over }; };

test("observeSync: needs N consecutive confirming reads; flapping/unknown reset; timeout and read cap never conclude", async () => {
  let r = await observeSync(base([cal("available", 1), cal("reserved", 0), cal("reserved", 0)]));
  assert.deepEqual([r.code, r.reads, r.history, r.observedAfterMs], ["OBSERVED_STABLE", 3, ["open", "blocked", "blocked"], 120000]);
  r = await observeSync(base([cal("reserved", 0), "throw", cal("reserved", 0), cal("reserved", 0)]));
  assert.deepEqual([r.code, r.history], ["OBSERVED_STABLE", ["blocked", "unknown", "blocked", "blocked"]]);
  r = await observeSync(base([cal("available", 1)], { timeoutMs: 180000 }));
  assert.deepEqual([r.code, r.reads], ["TIMEOUT", 4], "reads at 0/60/120/180 s; the next would exceed 180 s");
  r = await observeSync(base([cal("available", 1)], { maxReads: 4 }));
  assert.deepEqual([r.code, r.reads], ["READ_CAP_REACHED", 4]);
  r = await observeSync(base([cal("reserved", 0), cal("available", 1), cal("reserved", 0), cal("available", 1)], { maxReads: 4 }));
  assert.equal(r.code, "READ_CAP_REACHED", "flapping never confirms");
  r = await observeSync(base([cal("available", 1), cal("available", 1)], { expect: "open" }));
  assert.deepEqual([r.code, r.reads], ["OBSERVED_STABLE", 2]);
  for (const over of [{ nights: [] }, { nights: ["2030-1-1"] }, { nights: [N[0], N[0]] }, { expect: "maybe" }, { intervalMs: 10 }, { timeoutMs: 999999999 },
    { maxReads: 0 }, { maxReads: 500 }, { confirmReads: 0 }, { sleep: null }, { readCalendar: null }]) {
    assert.equal((await observeSync(base([cal("reserved", 0)], over))).code, "INVALID_OPTIONS", JSON.stringify(over));
  }
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

test("containment: no listing/currency/channel constants, no I/O, nothing imports it", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-connected/safeguards.mjs"), "utf8");
  for (const re of [/60\d{4}/, /\b(USD|MXN)\b/, /airbnb\.com|rooms\//i, /\bimport\b/, /fetch\(|process\.env|console\.|writeFileSync|readFileSync/]) assert.doesNotMatch(src, re, String(re));
  const walk = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" ? [] : walk(join(p, e.name))) : [join(p, e.name)]);
  for (const f of [...walk("api"), ...walk("lib"), ...walk("scripts")].filter((f) => !f.endsWith("safeguards.mjs"))) assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /e4-connected/, f);
});
