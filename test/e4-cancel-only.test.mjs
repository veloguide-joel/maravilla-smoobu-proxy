// E4 cancel-only recovery (scripts/e4-recovery/cancel-only.mjs) — offline. Synthetic in-memory "world" only (NOT provider
// evidence); mock git/prompt/fetch; FAKE secrets. The global fetch is a throwing spy that must never be called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const M = await import("../scripts/e4-recovery/cancel-only.mjs");
const { TARGET, BASELINE, CONFIRM_TOKEN, RECOVERY_HASH, RECOVERY_SOURCES, RECOVERY_EXIT, LIST_MAX_PAGES, LOOKUP_PAGES,
  checkAttempt2Journal, traverseList, evaluateCalendar, runRecovery, runRecoveryCli, guardFetch } = M;
const adapter = await import("../lib/hostaway-reservations.js");
const { createFileJournal, readJournalFile, journalFileName } = await import("../scripts/e4-write-runner/journal.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "e".repeat(40);
const NOW = () => new Date("2026-10-23T18:00:00.000Z");
const RID = 70636076;
const FAKE = { account: "98765", secret: "FAKE-secret-DO-NOT-LEAK", token: "FAKE-token-DO-NOT-LEAK" };
const CHANNEL_RES = "98765-606998-2000-1111111111";
const LEAKS = [FAKE.account, FAKE.secret, FAKE.token, CHANNEL_RES, "Joel", "veloguide", "PROVIDER-TEXT", "MESSAGE-BODY"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };

// ---------- synthetic world ----------
function world(over = {}) {
  const res = { id: RID, hostawayReservationId: String(RID), listingMapId: 606998, channelId: 2000, reservationId: CHANNEL_RES,
    arrivalDate: "2027-03-10", departureDate: "2027-03-12", totalPrice: 250, currency: "USD", status: "new",
    guestName: "Joel Test", guestEmail: "Joel@veloguide.com", hostNote: "PROVIDER-TEXT",
    customFieldValues: [{ customFieldId: 105433, value: "MV-OTHL9CQU" }], ...(over.reservation ?? {}) };
  const w = {
    res, log: [],
    conversations: over.conversations ?? [{ id: 55098382, reservationId: String(RID), lastMessage: "MESSAGE-BODY" }],
    tasks: over.tasks ?? [], charges: over.charges ?? [],
    convPage: over.convPage ?? 100, convCount: over.convCount, chargesCount: over.chargesCount,
    readHook: over.readHook, cancelReply: over.cancelReply, afterCancel: over.afterCancel, calendarReply: over.calendarReply, lookupExtra: over.lookupExtra
  };
  const ok = (result, extra = {}) => ({ httpStatus: 200, json: { status: "success", result: JSON.parse(JSON.stringify(result)), ...extra } });
  let reads = 0;
  w.handle = (method, path, q, body) => {
    w.log.push(`${method} ${path}`);
    if (method === "GET" && path === `/reservations/${RID}`) { reads++; return w.readHook ? (w.readHook(reads, w) ?? ok(w.res)) : ok(w.res); }
    if (method === "GET" && path === "/reservations") {
      if (q.afterId !== undefined) return ok([]);
      return ok([w.res, ...(w.lookupExtra ?? [])]);
    }
    if (method === "GET" && path === "/guestPayments/charges") return ok(w.charges, { count: w.chargesCount === undefined ? w.charges.length : w.chargesCount });
    if (method === "GET" && (path === "/conversations" || path === "/tasks")) {
      const list = path === "/conversations" ? w.conversations : w.tasks;
      const size = path === "/conversations" ? w.convPage : 100;
      const off = Number(q.offset);
      const extra = path === "/conversations" && w.convCount !== undefined ? { count: w.convCount } : {};
      return ok(list.slice(off, off + Math.min(size, Number(q.limit))), extra);
    }
    if (method === "PUT" && path === `/reservations/${RID}/statuses/cancelled`) {
      if (w.cancelReply) return w.cancelReply(w);
      w.res.status = "cancelled";
      if (w.afterCancel) w.afterCancel(w);
      return ok(w.res);
    }
    if (method === "GET" && path === "/listings/606998/calendar") {
      if (w.calendarReply) return w.calendarReply(w);
      const st = w.res.status === "cancelled" ? "available" : "reserved";
      return ok([{ date: "2027-03-10", status: st, isAvailable: st === "available" ? 1 : 0 }, { date: "2027-03-11", status: st, isAvailable: st === "available" ? 1 : 0 }]);
    }
    return { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
  };
  w.transport = { send: async (req) => { const r = w.handle(req.method, req.path, req.query ?? {}, req.body); return r === "throw" ? Promise.reject(new Error("x")) : r; } };
  w.fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/v1/accessTokens") { w.log.push("POST /accessTokens"); return new Response(JSON.stringify({ access_token: FAKE.token }), { status: 200 }); }
    const r = w.handle(init.method ?? "GET", u.pathname.replace(/^\/v1/, ""), Object.fromEntries(u.searchParams), init.body);
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.json), { status: r.httpStatus });
  };
  return w;
}
const memJournal = (failOn) => { const es = []; return { durable: true, entries: es, load: () => es.map((e) => JSON.parse(JSON.stringify(e))),
  append: (e) => { if (failOn && failOn(e)) throw new Error("disk"); es.push(JSON.parse(JSON.stringify(e))); }, close() {} }; };
const run = async (w, j = memJournal()) => ({ r: await runRecovery({ transport: w.transport, journal: j, now: NOW, timeoutMs: 50 }), j, w });
const puts = (w) => w.log.filter((l) => l.startsWith("PUT "));

// The original attempt-2 journal, shaped exactly as the reviewed runner (ad5510f) writes it (synthetic values).
const at = (s) => `2026-10-23T15:28:${s}Z`;
const A2 = [
  { type: "run-start", runId: "0123456789abcdef", manifestHash: TARGET.attempt2Hash, refs: ["MV-PROBE1234", "MV-OTHL9CQU"], at: at("00.100") },
  { type: "read", step: "P0_PREFLIGHT_PRICE", kind: "calc", code: "PRICE_OK", observedTotalMinor: 25000, httpStatus: 200, at: at("01.000") },
  { type: "read", step: "P1_PREFLIGHT_CLEAR", kind: "lookup", code: "NOT_FOUND_NON_AUTHORITATIVE", ref: "MV-PROBE1234", itemsSeen: 0, at: at("02.000") },
  { type: "intent", step: "HW1_CREATE", kind: "create", ref: "MV-OTHL9CQU", from: "2027-03-10", to: "2027-03-12", totalMinor: 25000 }, // gate-written: no `at` (source-authentic)
  { type: "outcome", step: "HW1_CREATE", kind: "create", ref: "MV-OTHL9CQU", code: "RESERVATION_ID_INCONSISTENT", evidence: { outcome: "ambiguous", code: "RESERVATION_ID_INCONSISTENT", httpStatus: 200 }, at: at("04.000") },
  { type: "side-effect-check", step: "HW1_CREATE", code: "SIDE_EFFECT_CHECK_UNKNOWN", at: at("04.100") },
  { type: "halt", step: "HW1_CREATE", code: "SIDE_EFFECT_CHECK_UNKNOWN", at: at("04.200") },
  { type: "reconcile", step: "HR_RECONCILE", ref: "MV-OTHL9CQU", code: "ITEM_RESERVATION_ID_INCONSISTENT", at: at("05.000") },
  { type: "run-end", code: "HALTED", at: at("05.100") }
];

// ---------- pure checks ----------
test("attempt-2 journal: only 'one create for MV-OTHL9CQU, never a cancel, run ended HALTED' qualifies", () => {
  assert.deepEqual(checkAttempt2Journal(A2), { ok: true, code: "ATTEMPT2_JOURNAL_CANCEL_UNUSED" });
  const ins = (i, e) => [...A2.slice(0, i), e, ...A2.slice(i)];
  const bad = {
    NOT_ATTEMPT2: A2.map((e, i) => (i === 0 ? { ...e, manifestHash: "c".repeat(64) } : e)),
    REF_NOT_IN_RUN: A2.map((e, i) => (i === 0 ? { ...e, refs: ["MV-PROBE1234", "MV-ZZZZZZZZ"] } : e)),
    NOT_HALTED: A2.map((e, i) => (i === A2.length - 1 ? { ...e, code: "COMPLETED" } : e)),
    NO_END: A2.slice(0, -1),
    CANCEL_INTENT: ins(6, { type: "intent", step: "HW2_CANCEL", kind: "cancel", reservationId: RID, at: at("04.150") }),
    CANCEL_OUTCOME: ins(6, { type: "outcome", step: "HW2_CANCEL", kind: "cancel", code: "X", at: at("04.150") }),
    TWO_CREATES: ins(4, A2[3]),
    OTHER_REF: A2.map((e, i) => (i === 3 ? { ...e, ref: "MV-ZZZZZZZZ" } : e)),
    OTHER_OUTCOME: A2.map((e, i) => (i === 4 ? { ...e, code: "VERIFIED_CREATED" } : e)),
    NO_OUTCOME: A2.filter((e, i) => i !== 4),
    OUTCOME_FIRST: [A2[0], A2[1], A2[2], A2[4], A2[3], ...A2.slice(5)],
    TWO_RUNS: [A2[0], ...A2],
    EMPTY: []
  };
  for (const [name, es] of Object.entries(bad)) assert.equal(checkAttempt2Journal(es).ok, false, name);
  assert.equal(checkAttempt2Journal(null).ok, false);
});

test("traverseList: terminal EMPTY page at offset = items actually received; anything unprovable is UNKNOWN", async () => {
  const pages = (list, { size = 100, count, hook } = {}) => {
    const calls = [];
    const f = async ({ offset }) => { calls.push(offset); if (hook) { const h = hook(offset, calls.length); if (h !== undefined) return h; }
      return { httpStatus: 200, json: { status: "success", result: list.slice(offset, offset + size), ...(count === undefined ? {} : { count }) } }; };
    return { f, calls };
  };
  const item = (id, rid = String(RID)) => ({ id, reservationId: rid });
  let p = pages([item(5)]);
  assert.deepEqual(await traverseList(p.f, "CONVERSATIONS", RID), { state: "complete", code: "CONVERSATIONS_COMPLETE", ids: [5], pagesRead: 2, countSeen: false });
  assert.deepEqual(p.calls, [0, 1]);
  p = pages([item(5), item(6)], { size: 1 });                       // server caps below the requested limit
  assert.deepEqual((await traverseList(p.f, "X", RID)).ids, [5, 6]);
  assert.deepEqual(p.calls, [0, 1, 2], "advances by records actually returned");
  p = pages([]);
  assert.deepEqual([(await traverseList(p.f, "TASKS", RID)).state, p.calls], ["complete", [0]]);
  p = pages([item(5)], { count: 1 });
  assert.equal((await traverseList(p.f, "X", RID)).countSeen, true);
  const unknown = async (pg, code) => { const r = await traverseList(pg.f, "X", RID); assert.deepEqual([r.state, r.code], ["unknown", `X_${code}`], code); };
  await unknown(pages([item(5)], { count: 2 }), "COUNT_INCONSISTENT");
  await unknown(pages([], { count: 1 }), "COUNT_INCONSISTENT");
  await unknown(pages([item(5), item(6)], { size: 1, count: 1 }), "COUNT_INCONSISTENT");
  await unknown(pages([item(5)], { hook: (o, n) => (n === 2 ? { httpStatus: 200, json: { status: "success", result: [], count: 1 } } : undefined) }), "COUNT_CHANGED");
  await unknown(pages([item(5)], { count: 1, hook: (o, n) => (n === 2 ? { httpStatus: 200, json: { status: "success", result: [] } } : undefined) }), "COUNT_CHANGED");
  await unknown(pages([item(5)], { count: "1" }), "COUNT_INVALID");
  await unknown(pages([item(5), item(5)], { size: 1 }), "DUPLICATE_ITEM");
  await unknown(pages([item(5, "70636077")]), "FILTER_NOT_APPLIED");
  await unknown(pages([item(5, null)]), "FILTER_NOT_APPLIED");
  await unknown(pages([{ id: "5", reservationId: RID }]), "ITEM_ID_INVALID");
  await unknown(pages([item(1), item(2), item(3), item(4)], { size: 1 }), "PAGE_CAP_REACHED");
  await unknown(pages(Array.from({ length: 101 }, (_, i) => item(i + 1)), { size: 101 }), "PAGE_OVER_LIMIT");
  await unknown(pages([], { hook: () => ({ httpStatus: 500, json: {} }) }), "HTTP_NOT_OK");
  await unknown(pages([], { hook: () => ({ transportError: true }) }), "TRANSPORT_UNCERTAIN");
  await unknown(pages([], { hook: () => ({ httpStatus: 200, json: { status: "success", result: {} } }) }), "MALFORMED");
  await unknown({ f: async () => { throw new Error("x"); } }, "TRANSPORT_UNCERTAIN");
  assert.equal(LIST_MAX_PAGES, 3);
});

test("calendar: both nights available + isAvailable 1/true => reopened; anything else is not", () => {
  const cal = (days) => ({ httpStatus: 200, json: { status: "success", result: days } });
  const d = (date, status = "available", isAvailable = 1) => ({ date, status, isAvailable });
  assert.equal(evaluateCalendar(cal([d("2027-03-10"), d("2027-03-11", "available", true)])), "CALENDAR_REOPENED");
  assert.equal(evaluateCalendar(cal([d("2027-03-10"), d("2027-03-11", "reserved", 0)])), "CALENDAR_NOT_REOPENED");
  assert.equal(evaluateCalendar(cal([d("2027-03-10"), d("2027-03-11", "available", 0)])), "CALENDAR_NOT_REOPENED");
  assert.equal(evaluateCalendar(cal([d("2027-03-10")])), "CALENDAR_DAYS_MISSING");
  assert.equal(evaluateCalendar(cal([d("2027-03-10"), d("2027-03-10")])), "CALENDAR_DAYS_MISSING");
  assert.equal(evaluateCalendar({ transportError: true }), "CALENDAR_TRANSPORT_UNCERTAIN");
  assert.equal(evaluateCalendar({ httpStatus: 200, json: { status: "fail" } }), "CALENDAR_MALFORMED");
});

// ---------- the run ----------
test("happy recovery: identity -> unique ref -> baseline -> fresh read -> ONE cancel of 70636076 -> verified; nothing else written", async () => {
  const { r, j, w } = await run(world());
  assert.deepEqual([r.status, r.allPostChecksPassed, r.cancel, r.halt, r.postcancelStatus, r.calendar], ["CANCELLED_VERIFIED", true, { sent: true, code: "VERIFIED_CANCELLED" }, null, "cancelled", "CALENDAR_REOPENED"]);
  assert.deepEqual(puts(w), [`PUT /reservations/${RID}/statuses/cancelled`]);
  assert.ok(!w.log.some((l) => l.startsWith("POST ")), "never a create or any POST");
  const iPut = w.log.indexOf(puts(w)[0]);
  assert.equal(w.log[iPut - 1], `GET /reservations/${RID}`, "fresh read immediately before the cancel");
  assert.deepEqual([r.sideEffectsBefore.code, r.sideEffectsBefore.conversations.ids, r.sideEffectsAfter.code], ["SIDE_EFFECTS_MATCH_BASELINE", [55098382], "SIDE_EFFECTS_MATCH_BASELINE"]);
  const types = j.entries.map((e) => `${e.type}:${e.step ?? ""}`);
  assert.ok(types.indexOf("intent:W1_CANCEL") > -1 && types.indexOf("intent:W1_CANCEL") < types.indexOf("outcome:W1_CANCEL"));
  assert.equal(j.entries.filter((e) => e.type === "intent").length, 1);
  assert.equal(j.entries[0].manifestHash, RECOVERY_HASH);
  leakFree(r); leakFree(j.entries);
});

test("halts BEFORE the cancel (no PUT): identity, uniqueness, baseline and fresh-read failures", async () => {
  const cases = {
    "status modified": { reservation: { status: "modified" } }, "already cancelled": { reservation: { status: "cancelled" } },
    "total": { reservation: { totalPrice: 260 } }, "currency": { reservation: { currency: "MXN" } }, "listing": { reservation: { listingMapId: 606999 } },
    "dates": { reservation: { departureDate: "2027-03-13" } }, "channel": { reservation: { channelId: 2005 } },
    "ref": { reservation: { customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZZZ" }] } },
    "alias different": { reservation: { hostawayReservationId: "70636077" } }, "alias null": { reservation: { hostawayReservationId: null } },
    "duplicate ref": { lookupExtra: [{ id: 70636099, hostawayReservationId: 70636099, listingMapId: 606998, channelId: 2000, arrivalDate: "2027-03-10", departureDate: "2027-03-12",
      totalPrice: 250, currency: "USD", status: "new", customFieldValues: [{ customFieldId: 105433, value: "MV-OTHL9CQU" }] }] },
    "extra conversation": { conversations: [{ id: 55098382, reservationId: String(RID) }, { id: 55098383, reservationId: String(RID) }] },
    "baseline conversation missing": { conversations: [] },
    "different conversation": { conversations: [{ id: 55098399, reservationId: String(RID) }] },
    "conversation filter not applied": { conversations: [{ id: 55098382, reservationId: "1" }] },
    "conversation count inconsistent": { convCount: 2 },
    "conversations unprovable (cap)": { conversations: [1, 2, 3].map((k) => ({ id: 55098382 + k, reservationId: String(RID) })), convPage: 1 },
    "task present": { tasks: [{ id: 9, reservationId: RID }] },
    "charge present": { charges: [{ id: 1, reservationId: RID }] }, "charges count missing": { chargesCount: null },
    "fresh read changed": { readHook: (n, w) => (n === 2 ? { httpStatus: 200, json: { status: "success", result: { ...w.res, status: "modified" } } } : undefined) },
    "fresh read failed": { readHook: (n) => (n === 2 ? { httpStatus: 503, json: {} } : undefined) },
    "identity read transport": { readHook: (n) => (n === 1 ? "throw" : undefined) }
  };
  for (const [name, over] of Object.entries(cases)) {
    const { r, w, j } = await run(world(over));
    assert.equal(puts(w).length, 0, name);
    assert.deepEqual([r.status, r.cancel.sent], ["HALTED", false], name);
    assert.ok(r.halt && /^R[1-4]_/.test(r.halt.step), `${name}: ${JSON.stringify(r.halt)}`);
    assert.equal(j.entries.filter((e) => e.type === "intent").length, 0, name);
    leakFree(r);
  }
});

test("cancel ambiguity: exactly ONE PUT, HALTED, read-only verification after, never a retry", async () => {
  const mism = (w) => ({ httpStatus: 200, json: { status: "success", result: { ...w.res, status: "new" } } });
  for (const [name, reply] of [["5xx", () => ({ httpStatus: 503, json: {} })], ["transport", () => "throw"], ["mismatch", mism],
    ["fail envelope", () => ({ httpStatus: 200, json: { status: "fail", result: "PROVIDER-TEXT" } })]]) {
    const { r, w } = await run(world({ cancelReply: reply }));
    assert.equal(puts(w).length, 1, name);
    assert.deepEqual([r.status, r.cancel.sent, r.allPostChecksPassed], ["HALTED", true, false], name);
    assert.equal(r.halt.step, "W1_CANCEL", name);
    const after = w.log.slice(w.log.indexOf(puts(w)[0]) + 1);
    assert.ok(after.length > 0 && after.every((l) => l.startsWith("GET ")), `${name}: reads only after`);
    leakFree(r);
  }
});

test("post-cancel checks are reported, never acted on: calendar not reopened / new side effect / post read mismatch", async () => {
  let { r, w } = await run(world({ calendarReply: () => ({ httpStatus: 200, json: { status: "success", result: [{ date: "2027-03-10", status: "reserved", isAvailable: 0 }, { date: "2027-03-11", status: "reserved", isAvailable: 0 }] } }) }));
  assert.deepEqual([r.status, r.allPostChecksPassed, r.calendar, puts(w).length], ["CANCELLED_VERIFIED", false, "CALENDAR_NOT_REOPENED", 1]);
  ({ r, w } = await run(world({ afterCancel: (w2) => { w2.tasks.push({ id: 77, reservationId: RID }); } })));
  assert.deepEqual([r.status, r.allPostChecksPassed, r.sideEffectsAfter.code], ["CANCELLED_VERIFIED", false, "TASKS_BASELINE_MISMATCH"]);
  ({ r, w } = await run(world({ readHook: (n, w2) => (n === 3 ? { httpStatus: 200, json: { status: "success", result: { ...w2.res, totalPrice: 0 } } } : undefined) })));
  assert.deepEqual([r.status, r.postcancelIdentityOk, r.allPostChecksPassed], ["HALTED", false, false]);
});

test("journal: if the cancel intent cannot be written durably, nothing is sent", async () => {
  const { r, w } = await run(world(), memJournal((e) => e.type === "intent"));
  assert.deepEqual([puts(w).length, r.cancel.sent, r.status, r.halt.step], [0, false, "HALTED", "W1_CANCEL"]);
  assert.deepEqual([r.journalDurable, r.journalFailures, r.allPostChecksPassed], [false, ["W1_CANCEL"], false]);
});

test("attempt-2 journal (strict): only the exact reviewed ad5510f sequence, fields and bindings; anything else refused", () => {
  const set = (i, over) => A2.map((e, k) => (k === i ? { ...e, ...over } : e));
  const drop = (i, key) => A2.map((e, k) => { if (k !== i) return e; const c = { ...e }; delete c[key]; return c; });
  const ins = (i, e) => [...A2.slice(0, i), e, ...A2.slice(i)];
  const bad = {
    "unknown type": ins(5, { type: "probe", step: "HW1_CREATE", at: at("04.050") }),
    "unknown step": set(1, { step: "P9_UNKNOWN" }),
    "unknown field": set(3, { forceOverbooking: true }),
    "intent from": set(3, { from: "2027-03-11" }), "intent to": set(3, { to: "2027-03-13" }), "intent total": set(3, { totalMinor: 26000 }),
    "intent kind": set(3, { kind: "cancel" }), "intent ref": set(3, { ref: "MV-ZZZZZZZZ" }),
    "outcome ref": set(4, { ref: "MV-ZZZZZZZZ" }), "outcome kind": set(4, { kind: "read" }), "outcome code": set(4, { code: "VERIFIED_CREATED" }),
    "outcome with id": set(4, { evidence: { outcome: "ambiguous", code: "RESERVATION_ID_INCONSISTENT", httpStatus: 200, reservationId: 70636076 } }),
    "outcome evidence created": set(4, { evidence: { outcome: "created", code: "VERIFIED_CREATED", httpStatus: 200 } }),
    "outcome transport": set(4, { transport: "TIMEOUT" }), "outcome http 5xx": set(4, { evidence: { outcome: "ambiguous", code: "RESERVATION_ID_INCONSISTENT", httpStatus: 503 } }),
    "probe ref in intent position": set(0, { refs: ["MV-OTHL9CQU", "MV-PROBE1234"] }), "three refs": set(0, { refs: ["MV-PROBE1234", "MV-OTHL9CQU", "MV-EXTRA123"] }),
    "price not ok": set(1, { code: "PRICE_TOTAL_NOT_EXACT" }), "items seen": set(2, { itemsSeen: 1 }),
    "halt other": set(6, { code: "CREATE_NOT_VERIFIED:RESERVATION_ID_INCONSISTENT" }), "side-effect missing": A2.filter((e, k) => k !== 5),
    "reconcile missing": A2.filter((e, k) => k !== 7), "second reconcile": ins(8, A2[7]), "reordered": [A2[0], A2[2], A2[1], ...A2.slice(3)],
    "truncated": A2.slice(0, 7), "extra trailing": [...A2, A2[8]], "potential write after halt": ins(7, { ...A2[3], at: at("04.250") }),
    "timestamp backwards": set(4, { at: at("01.500") }), "timestamp format": set(2, { at: "2026-10-23T15:28:02Z" }),
    "run-end completed": set(8, { code: "COMPLETED" }), "runId invalid": set(0, { runId: "xyz" }), "missing at": drop(1, "at"),
    "intent with fabricated at": set(3, { at: at("03.000") }), "outcome missing at": drop(4, "at")
  };
  for (const [name, es] of Object.entries(bad)) assert.equal(checkAttempt2Journal(es).ok, false, name);
  assert.equal(checkAttempt2Journal(A2).ok, true);
});

test("durability: ANY journal append failure after the cancel latches — status stays truthful, but never ok/allPostChecksPassed; no extra write", async () => {
  const failOn = {
    "outcome": (e) => e.type === "outcome",
    "post-cancel read": (e) => e.type === "read" && e.step === "R5_POSTCANCEL",
    "side effects after": (e) => e.type === "side-effect-check" && e.step === "R6_SIDE_EFFECTS_AFTER",
    "calendar read": (e) => e.type === "read" && e.step === "R7_CALENDAR",
    "run-end": (e) => e.type === "run-end"
  };
  for (const [name, f] of Object.entries(failOn)) {
    const { r, w } = await run(world(), memJournal(f));
    assert.equal(puts(w).length, 1, name);
    assert.equal(r.journalDurable, false, name);
    assert.equal(r.allPostChecksPassed, false, name);
    assert.ok(r.journalFailures.length >= 1, name);
    if (name === "run-end") assert.deepEqual([r.runEndRecorded, r.journalFailures], [false, ["RUN_END"]]);
    if (name === "outcome") assert.equal(r.halt.code, "JOURNAL_WRITE_FAILED");
    assert.ok(["CANCELLED_VERIFIED", "HALTED"].includes(r.status), name);
  }
  const ok = await run(world());
  assert.deepEqual([ok.r.journalDurable, ok.r.runEndRecorded, ok.r.journalFailures, ok.r.allPostChecksPassed], [true, true, [], true]);
  const startFail = await run(world(), memJournal((e) => e.type === "run-start"));
  assert.deepEqual([startFail.r.status, startFail.r.journalDurable, puts(startFail.w).length, startFail.w.log.length], ["REFUSED", false, 0, 0]);
});

test("cli: a durability failure (run-end / post-cancel read) is never ok and never exit 0, even though the provider cancel verified", async () => {
  for (const f of [(e) => e.type === "run-end", (e) => e.type === "read" && e.step === "R5_POSTCANCEL"]) {
    const dir = folder();
    const w = world();
    const r = await runRecoveryCli(["--journal-dir", dir.jdir, "--confirm", CONFIRM_TOKEN, "--reviewed-commit", SHA], { git: git(), fetchImpl: w.fetchImpl, now: NOW,
      sleep: async () => {}, timeoutMs: 200, prompt: async () => ({ accountId: FAKE.account, clientSecret: FAKE.secret }), createJournal: () => memJournal(f) });
    assert.deepEqual([r.exitCode, r.output.ok, r.output.journalDurable, r.output.allPostChecksPassed, r.output.status], [RECOVERY_EXIT.HALTED, false, false, false, "CANCELLED_VERIFIED"]);
    assert.equal(puts(w).length, 1);
  }
});

// ---------- allowlist ----------
test("guardFetch: only the planned requests, each within its count; creates, other ids/paths/queries refused before fetch", async () => {
  let inner = 0;
  const g = guardFetch(async () => { inner++; return new Response("{}"); });
  const go = async (u, init = {}) => { try { await g.guarded(u, init); return "SENT"; } catch (e) { return e.name; } };
  const B = "https://api.hostaway.com/v1";
  for (const [u, init] of [[`${B}/reservations`, { method: "POST", body: "{}" }], [`${B}/reservations/70636077/statuses/cancelled`, { method: "PUT", body: "{}" }],
    [`${B}/reservations/${RID}`, { method: "PUT", body: "{}" }], [`${B}/listings/606998/calendar/priceDetails`, { method: "POST", body: "{}" }],
    [`${B}/conversations?reservationId=1&limit=100&offset=0`, {}], [`${B}/conversations?reservationId=${RID}&limit=100&offset=0&x=1`, {}],
    [`${B}/conversations/55098382/messages`, {}], [`${B}/listings/606998/calendar?startDate=2027-03-01&endDate=2027-03-31`, {}],
    [`${B}/reservations/${RID}`, {}], [`${B}/reservations?listingId=603564&channelId=2000&arrivalStartDate=2027-03-10&arrivalEndDate=2027-03-10&limit=100&includeResources=1`, {}],
    ["https://evil.example/v1/accessTokens", { method: "POST", body: "x" }], [`${B}/reservations/${RID}?includeResources=1`, { method: "DELETE" }]]) {
    assert.equal(await go(u, init), "LocalRefusal", `${init.method ?? "GET"} ${u}`);
  }
  assert.equal(inner, 0);
  assert.equal(await go(`${B}/reservations/${RID}/statuses/cancelled`, { method: "PUT", body: "{}" }), "SENT");
  assert.equal(await go(`${B}/reservations/${RID}/statuses/cancelled`, { method: "PUT", body: "{}" }), "LocalRefusal", "second cancel refused");
  for (let i = 0; i < 3; i++) assert.equal(await go(`${B}/reservations/${RID}?includeResources=1`), "SENT");
  assert.equal(await go(`${B}/reservations/${RID}?includeResources=1`), "LocalRefusal", "fourth read refused");
  assert.equal(LOOKUP_PAGES, adapter.LOOKUP_MAX_PAGES);
});

// ---------- CLI: everything before the prompt; a real-file end-to-end; one run ever ----------
const REAL = spawnSync("git", ["hash-object", "--", ...RECOVERY_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
const git = (opt = {}) => (a) => a[0] === "rev-parse" ? { status: 0, stdout: `${opt.head ?? SHA}\n` } : a[0] === "status" ? { status: 0, stdout: "" }
  : a[0] === "ls-tree" ? { status: 0, stdout: RECOVERY_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: REAL.join("\n") };
function folder(a2 = A2) {
  const dir = mkdtempSync(join(tmpdir(), "e4-recover-")); const jdir = join(dir, "journal"); mkdirSync(jdir);
  writeFileSync(join(jdir, "e4-journal-2b7d851c1fbf.jsonl"), "{\"type\":\"run-start\"}\n{\"type\":\"run-end\",\"code\":\"HALTED\"}\n");
  if (a2 !== null) writeFileSync(join(jdir, journalFileName(TARGET.attempt2Hash)), typeof a2 === "string" ? a2 : a2.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return { dir, jdir };
}
const snap = (dir) => readdirSync(dir, { recursive: true }).sort().map((p) => { try { return `${p}:${createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")}`; } catch { return p; } });
async function cli(f, { argv, w = world(), g = git(), prompt } = {}) {
  let prompts = 0;
  const r = await runRecoveryCli(argv ?? ["--journal-dir", f.jdir, "--confirm", CONFIRM_TOKEN, "--reviewed-commit", SHA], { git: g, fetchImpl: w.fetchImpl, now: NOW, sleep: async () => {}, timeoutMs: 200,
    prompt: prompt ?? (async () => { prompts++; return { accountId: FAKE.account, clientSecret: FAKE.secret }; }) });
  return { r, prompts, w };
}

test("cli: every refusal happens before the prompt and before any network, and writes nothing", async () => {
  const f = folder();
  const before = snap(f.dir);
  const cases = [
    [[], "USAGE"], [["--journal-dir", f.jdir, "--confirm", CONFIRM_TOKEN], "USAGE"],
    [["--journal-dir", f.jdir, "--confirm", CONFIRM_TOKEN, "--reviewed-commit", "abc"], "REVIEWED_COMMIT_INVALID"],
    [["--journal-dir", f.jdir, "--confirm", "E4-HAPPY-f34575db1138", "--reviewed-commit", SHA], "CONFIRM_TOKEN_MISMATCH"],
    [["--journal-dir", f.jdir, "--journal-dir", f.jdir, "--reviewed-commit", SHA], "USAGE"]
  ];
  for (const [argv, code] of cases) { const { r, prompts, w } = await cli(f, { argv }); assert.deepEqual([r.output.error, prompts, w.log.length], [code, 0, 0], code); }
  let x = await cli(f, { g: git({ head: "f".repeat(40) }) });
  assert.deepEqual([x.r.output.stage, x.prompts, x.w.log.length], ["provenance", 0, 0]);
  for (const [a2, code] of [[null, "ATTEMPT2_JOURNAL_UNREADABLE"], ["{\"type\":\"run-start\"", "ATTEMPT2_JOURNAL_CORRUPT"],
    [[...A2.slice(0, 6), { type: "intent", step: "HW2_CANCEL", kind: "cancel", reservationId: RID, at: at("04.150") }, ...A2.slice(6)], "ATTEMPT2_JOURNAL_CANCEL_ALREADY_ATTEMPTED"]]) {
    const g2 = folder(a2);
    x = await cli(g2);
    assert.deepEqual([x.r.exitCode, x.r.output.stage, x.r.output.error, x.prompts, x.w.log.length], [RECOVERY_EXIT.REFUSED, "preflight", code, 0, 0], code);
  }
  x = await cli(f, { prompt: async () => { throw Object.assign(new Error(), { code: "ABORTED" }); } });
  assert.deepEqual([x.r.output.stage, x.r.output.error, x.w.log.length], ["credentials", "ABORTED", 0]);
  assert.deepEqual(snap(f.dir), before, "nothing written by any refusal");
});

test("cli end-to-end on real files: one cancel; original journals byte-identical; recovery journal created; a second run is refused before the prompt", async () => {
  const f = folder();
  const a2Path = join(f.jdir, journalFileName(TARGET.attempt2Hash));
  const a2Before = readFileSync(a2Path), firstBefore = readFileSync(join(f.jdir, "e4-journal-2b7d851c1fbf.jsonl"));
  const { r, prompts, w } = await cli(f);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.status, prompts], [RECOVERY_EXIT.OK, true, "CANCELLED_VERIFIED", 1]);
  assert.deepEqual(w.log.filter((l) => !l.startsWith("GET ")), ["POST /accessTokens", `PUT /reservations/${RID}/statuses/cancelled`]);
  assert.ok(readFileSync(a2Path).equals(a2Before));
  assert.ok(readFileSync(join(f.jdir, "e4-journal-2b7d851c1fbf.jsonl")).equals(firstBefore));
  const recFile = journalFileName(RECOVERY_HASH);
  assert.equal(r.output.recoveryJournalFile, recFile);
  const rec = readJournalFile(join(f.jdir, recFile));
  assert.deepEqual([rec[0].type, rec[0].manifestHash, rec.at(-1).type, rec.filter((e) => e.type === "intent").length], ["run-start", RECOVERY_HASH, "run-end", 1]);
  assert.equal(r.output.guard.cancel, 1);
  assert.equal(r.output.guard.refused, 0);
  leakFree(r.output); leakFree(readFileSync(join(f.jdir, recFile), "utf8"));
  const again = await cli(f);
  assert.deepEqual([again.r.output.stage, again.r.output.error, again.prompts, again.w.log.length], ["preflight", "RECOVERY_ALREADY_RUN", 0, 0]);
});

test("containment: no create/price paths, env, console or file writes of its own; nothing deployable imports it", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-recovery/cancel-only.mjs"), "utf8");
  for (const re of [/method: "POST"/, /priceDetails/, /buildCreateReservationRequest|executeHappyRun|planFor/, /process\.env/, /console\./,
    /writeFileSync|appendFileSync|createWriteStream|unlink|rmSync|renameSync|mkdirSync/]) assert.doesNotMatch(src, re, String(re));
  for (const d of ["api", "lib", "public"]) {
    const walk = (p) => readdirSync(join(ROOT, p), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)]);
    for (const f of walk(d)) assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /e4-recovery/, f);
  }
  assert.ok(readFileSync(join(ROOT, ".vercelignore"), "utf8").split("\n").includes("/scripts"));
  assert.deepEqual([CONFIRM_TOKEN, BASELINE.conversations, BASELINE.tasks], [`E4-RECOVER-${RECOVERY_HASH.slice(0, 12)}`, [55098382], []]);
  assert.equal(globalFetchCalls, 0);
});
