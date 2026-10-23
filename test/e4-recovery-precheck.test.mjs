// E4 recovery precheck (scripts/e4-recovery/precheck.mjs) — offline. Synthetic world (NOT provider evidence), mock git/
// prompt/fetch, FAKE secrets. The global fetch is a throwing spy that must never be called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const { runPrecheckCli, runPrecheck, journalCheck, calendarNights, guardFetch, PRECHECK_SOURCES, PRECHECK_EXIT } = await import("../scripts/e4-recovery/precheck.mjs");
const { TARGET, RECOVERY_HASH } = await import("../scripts/e4-recovery/cancel-only.mjs");
const { journalFileName } = await import("../scripts/e4-write-runner/journal.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "d".repeat(40);
const RID = 70636076;
const FAKE = { account: "98765", secret: "FAKE-secret-DO-NOT-LEAK", token: "FAKE-token-DO-NOT-LEAK" };
const CHANNEL_RES = "98765-606998-2000-1111111111";
const LEAKS = [FAKE.account, FAKE.secret, FAKE.token, CHANNEL_RES, "Joel", "veloguide", "PROVIDER-TEXT", "MESSAGE-BODY", "TASK-TITLE"];
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };

function world(over = {}) {
  const res = { id: RID, hostawayReservationId: String(RID), listingMapId: 606998, channelId: 2000, reservationId: CHANNEL_RES, arrivalDate: "2027-03-10",
    departureDate: "2027-03-12", totalPrice: 250, currency: "USD", status: "new", guestName: "Joel Test", guestEmail: "Joel@veloguide.com",
    customFieldValues: [{ customFieldId: 105433, value: "MV-OTHL9CQU" }], ...(over.reservation ?? {}) };
  const w = { log: [], conversations: over.conversations ?? [{ id: 55098382, reservationId: String(RID), lastMessage: "MESSAGE-BODY" }],
    tasks: over.tasks ?? [], charges: over.charges ?? [], convCount: over.convCount, calStatus: over.calStatus ?? "reserved" };
  const ok = (r, extra = {}) => ({ httpStatus: 200, json: { status: "success", result: JSON.parse(JSON.stringify(r)), ...extra } });
  w.handle = (method, path, q) => {
    w.log.push(`${method} ${path}`);
    if (method === "GET" && path === `/reservations/${RID}`) return ok(res);
    if (method === "GET" && path === "/reservations") return q.afterId !== undefined ? ok([]) : ok([res]);
    if (method === "GET" && path === "/guestPayments/charges") return ok(w.charges, { count: w.charges.length });
    if (method === "GET" && (path === "/conversations" || path === "/tasks")) {
      const list = path === "/conversations" ? w.conversations : w.tasks;
      return ok(list.slice(Number(q.offset), Number(q.offset) + 100), path === "/conversations" && w.convCount !== undefined ? { count: w.convCount } : {});
    }
    if (method === "GET" && path === "/listings/606998/calendar") return ok([{ date: "2027-03-10", status: w.calStatus, isAvailable: 0, note: "PROVIDER-TEXT" }, { date: "2027-03-11", status: w.calStatus, isAvailable: 0 }]);
    return { httpStatus: 404, json: { status: "fail", result: "PROVIDER-TEXT" } };
  };
  w.transport = { send: async (req) => w.handle(req.method, req.path, req.query ?? {}) };
  w.fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/v1/accessTokens") { w.log.push("POST /accessTokens"); return new Response(JSON.stringify({ access_token: FAKE.token }), { status: 200 }); }
    const r = w.handle(init.method ?? "GET", u.pathname.replace(/^\/v1/, ""), Object.fromEntries(u.searchParams));
    return new Response(JSON.stringify(r.json), { status: r.httpStatus });
  };
  return w;
}
const at = (s) => `2026-10-23T15:28:${s}Z`;
const A2 = [
  { type: "run-start", runId: "0123456789abcdef", manifestHash: TARGET.attempt2Hash, refs: ["MV-PROBE1234", "MV-OTHL9CQU"], at: at("00.100") },
  { type: "read", step: "P0_PREFLIGHT_PRICE", kind: "calc", code: "PRICE_OK", observedTotalMinor: 25000, httpStatus: 200, at: at("01.000") },
  { type: "read", step: "P1_PREFLIGHT_CLEAR", kind: "lookup", code: "NOT_FOUND_NON_AUTHORITATIVE", ref: "MV-PROBE1234", itemsSeen: 0, at: at("02.000") },
  { type: "intent", step: "HW1_CREATE", kind: "create", ref: "MV-OTHL9CQU", from: "2027-03-10", to: "2027-03-12", totalMinor: 25000 },
  { type: "outcome", step: "HW1_CREATE", kind: "create", ref: "MV-OTHL9CQU", code: "RESERVATION_ID_INCONSISTENT", evidence: { outcome: "ambiguous", code: "RESERVATION_ID_INCONSISTENT", httpStatus: 200 }, at: at("04.000") },
  { type: "side-effect-check", step: "HW1_CREATE", code: "SIDE_EFFECT_CHECK_UNKNOWN", at: at("04.100") },
  { type: "halt", step: "HW1_CREATE", code: "SIDE_EFFECT_CHECK_UNKNOWN", at: at("04.200") },
  { type: "reconcile", step: "HR_RECONCILE", ref: "MV-OTHL9CQU", code: "ITEM_RESERVATION_ID_INCONSISTENT", at: at("05.000") },
  { type: "run-end", code: "HALTED", at: at("05.100") }
];
function folder(a2 = A2, { recovery = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e4-precheck-")); const jdir = join(dir, "journal"); mkdirSync(jdir);
  writeFileSync(join(jdir, "e4-journal-2b7d851c1fbf.jsonl"), "{\"type\":\"run-start\"}\n");
  if (a2 !== null) writeFileSync(join(jdir, journalFileName(TARGET.attempt2Hash)), typeof a2 === "string" ? a2 : a2.map((e) => `${JSON.stringify(e)}\n`).join(""));
  if (recovery) writeFileSync(join(jdir, journalFileName(RECOVERY_HASH)), "{\"type\":\"run-start\"}\n");
  return { dir, jdir };
}
const snap = (dir) => readdirSync(dir, { recursive: true }).sort().map((p) => { try { return `${p}:${createHash("sha256").update(readFileSync(join(dir, p))).digest("hex")}`; } catch { return p; } });
const REAL = spawnSync("git", ["hash-object", "--", ...PRECHECK_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
const git = (opt = {}) => (a) => a[0] === "rev-parse" ? { status: 0, stdout: `${opt.head ?? SHA}\n` } : a[0] === "status" ? { status: 0, stdout: "" }
  : a[0] === "ls-tree" ? { status: 0, stdout: PRECHECK_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: REAL.join("\n") };
async function cli(mode, f, { w = world(), g = git(), prompt } = {}) {
  let prompts = 0;
  const r = await runPrecheckCli([mode, "--journal-dir", f.jdir, "--reviewed-commit", SHA], { git: g, fetchImpl: w.fetchImpl, sleep: async () => {}, timeoutMs: 200,
    prompt: prompt ?? (async () => { prompts++; return { accountId: FAKE.account, clientSecret: FAKE.secret }; }) });
  return { r, prompts, w };
}

test("journal-check (offline): zero prompt, zero network, zero writes; reports strict result, value-free shape, recovery-journal state", async () => {
  const f = folder(); const before = snap(f.dir);
  const { r, prompts, w } = await cli("--journal-check", f);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.attempt2Journal.code, r.output.recoveryJournal, r.output.network, r.output.filesWritten, prompts, w.log.length],
    [PRECHECK_EXIT.OK, true, "ATTEMPT2_JOURNAL_CANCEL_UNUSED", "ABSENT", "none", 0, 0, 0]);
  assert.deepEqual(r.output.recordShape.map((s) => `${s.type}:${s.step ?? ""}`), ["run-start:", "read:P0_PREFLIGHT_PRICE", "read:P1_PREFLIGHT_CLEAR", "intent:HW1_CREATE",
    "outcome:HW1_CREATE", "side-effect-check:HW1_CREATE", "halt:HW1_CREATE", "reconcile:HR_RECONCILE", "run-end:"]);
  assert.deepEqual(r.output.recordShape[3].fields, ["from", "kind", "ref", "step", "to", "totalMinor", "type"], "authentic intent has no `at`");
  assert.ok(!JSON.stringify(r.output).includes("MV-OTHL9CQU\",\"from") && !JSON.stringify(r.output.recordShape).includes("2027-03"), "no values in the shape");
  assert.deepEqual(snap(f.dir), before);
  for (const [fx, opts, code, rec] of [[null, {}, "ATTEMPT2_JOURNAL_UNREADABLE", "ABSENT"], ["{\"type\":", {}, "ATTEMPT2_JOURNAL_CORRUPT", "ABSENT"],
    [A2.slice(0, 7), {}, "ATTEMPT2_JOURNAL_TRUNCATED_OR_SHORT", "ABSENT"], [A2, { recovery: true }, "ATTEMPT2_JOURNAL_CANCEL_UNUSED", "PRESENT"]]) {
    const g = folder(fx, opts); const b = snap(g.dir);
    const x = await cli("--journal-check", g);
    assert.deepEqual([x.r.exitCode, x.r.output.ok, x.r.output.attempt2Journal.code, x.r.output.recoveryJournal, x.prompts, x.w.log.length], [PRECHECK_EXIT.INCOMPLETE, false, code, rec, 0, 0], code);
    assert.deepEqual(snap(g.dir), b);
  }
});

test("precheck: one token, bounded GETs only, no write ever; baseline reported precisely", async () => {
  const f = folder(); const before = snap(f.dir);
  const { r, prompts, w } = await cli("--precheck", f);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.precheckComplete, r.output.baselineMatches, prompts], [PRECHECK_EXIT.OK, true, true, true, 1]);
  assert.deepEqual(r.output.identity, { code: "IDENTITY_OK", status: "new" });
  assert.deepEqual(r.output.lookup, { code: "FOUND_BY_REF", sameId: true });
  assert.equal(r.output.charges, "CHARGES_NONE");
  assert.deepEqual(r.output.conversations, { code: "CONVERSATIONS_COMPLETE", pagesRead: 2, ids: [55098382], countSeen: false });
  assert.deepEqual(r.output.tasks, { code: "TASKS_COMPLETE", pagesRead: 1, ids: [], countSeen: false });
  assert.deepEqual(r.output.calendar.nights, [{ date: "2027-03-10", status: "reserved", isAvailable: false }, { date: "2027-03-11", status: "reserved", isAvailable: false }]);
  assert.ok(w.log.every((l) => l.startsWith("GET ") || l === "POST /accessTokens"));
  assert.equal(w.log.filter((l) => l === "POST /accessTokens").length, 1);
  assert.equal(r.output.guard.refused, 0);
  assert.deepEqual(snap(f.dir), before, "no file written");
  leakFree(r.output);
});

test("precheck: differences are reported, never acted on (extra/different conversation, task, charge, count metadata, identity)", async () => {
  const cases = [
    [{ conversations: [{ id: 55098399, reservationId: String(RID) }] }, (o) => o.precheckComplete && !o.baselineMatches && o.conversations.ids[0] === 55098399],
    [{ conversations: [] }, (o) => o.precheckComplete && !o.baselineMatches],
    [{ convCount: 1 }, (o) => o.baselineMatches && o.conversations.countSeen === true],
    [{ convCount: 2 }, (o) => !o.precheckComplete && o.conversations.code === "CONVERSATIONS_COUNT_INCONSISTENT"],
    [{ tasks: [{ id: 9, reservationId: RID, title: "TASK-TITLE" }] }, (o) => o.precheckComplete && !o.baselineMatches && o.tasks.ids[0] === 9],
    [{ charges: [{ id: 1, reservationId: RID }] }, (o) => o.precheckComplete && o.charges === "CHARGES_PRESENT" && !o.baselineMatches],
    [{ reservation: { status: "cancelled" } }, (o) => !o.precheckComplete && o.identity.code === "IDENTITY_MISMATCH"],
    [{ reservation: { hostawayReservationId: "70636077" } }, (o) => !o.precheckComplete && o.identity.code === "READ_RESERVATION_ID_INCONSISTENT"],
    [{ calStatus: "available" }, (o) => o.precheckComplete && !o.baselineMatches]
  ];
  for (const [over, pred] of cases) {
    const w = world(over);
    const o = await runPrecheck({ transport: w.transport, timeoutMs: 100 });
    assert.ok(pred(o), JSON.stringify({ over, o }));
    assert.ok(w.log.every((l) => l.startsWith("GET ")), "reads only");
    leakFree(o);
  }
});

test("refusals before prompt/network: usage, bad sha, provenance; prompt abort sends nothing", async () => {
  const f = folder();
  for (const argv of [[], ["--execute", "--journal-dir", f.jdir, "--reviewed-commit", SHA], ["--precheck", "--journal-dir", f.jdir], ["--precheck", "--journal-dir", f.jdir, "--reviewed-commit", "abc"]]) {
    let p = 0; const w = world();
    const r = await runPrecheckCli(argv, { git: git(), fetchImpl: w.fetchImpl, prompt: async () => { p++; } });
    assert.deepEqual([r.exitCode, p, w.log.length], [PRECHECK_EXIT.USAGE, 0, 0], JSON.stringify(argv));
  }
  const x = await cli("--precheck", f, { g: git({ head: "c".repeat(40) }) });
  assert.deepEqual([x.r.output.stage, x.prompts, x.w.log.length], ["provenance", 0, 0]);
  const y = await cli("--precheck", f, { prompt: async () => { throw Object.assign(new Error(), { code: "ABORTED" }); } });
  assert.deepEqual([y.r.output.stage, y.r.output.error, y.w.log.length], ["credentials", "ABORTED", 0]);
});

test("guard: no PUT/POST except the token, no other ids/paths/queries, hard per-request counts", async () => {
  let inner = 0;
  const g = guardFetch(async () => { inner++; return new Response("{}"); });
  const go = async (u, init = {}) => { try { await g.guarded(u, init); return "SENT"; } catch (e) { return e.name; } };
  const B = "https://api.hostaway.com/v1";
  for (const [u, init] of [[`${B}/reservations/${RID}/statuses/cancelled`, { method: "PUT", body: "{}" }], [`${B}/reservations`, { method: "POST", body: "{}" }],
    [`${B}/listings/606998/calendar/priceDetails`, { method: "POST", body: "{}" }], [`${B}/conversations/55098382/messages`, {}], [`${B}/reservations/70636077?includeResources=1`, {}],
    [`${B}/tasks?reservationId=${RID}&limit=100`, {}], [`${B}/listings/603564/calendar?startDate=2027-03-10&endDate=2027-03-11`, {}]]) {
    assert.equal(await go(u, init), "LocalRefusal", `${init.method ?? "GET"} ${u}`);
  }
  assert.equal(inner, 0);
  assert.equal(await go(`${B}/reservations/${RID}?includeResources=1`), "SENT");
  assert.equal(await go(`${B}/reservations/${RID}?includeResources=1`), "LocalRefusal", "second identity read refused");
  for (let k = 0; k < 3; k++) assert.equal(await go(`${B}/conversations?reservationId=${RID}&limit=100&offset=${k}`), "SENT");
  assert.equal(await go(`${B}/conversations?reservationId=${RID}&limit=100&offset=3`), "LocalRefusal", "page cap");
});

test("calendar night states and containment", () => {
  const ok = (days) => ({ httpStatus: 200, json: { status: "success", result: days } });
  assert.deepEqual(calendarNights(ok([{ date: "2027-03-10", status: "weird", isAvailable: 1 }])).nights,
    [{ date: "2027-03-10", status: "OTHER", isAvailable: true }, { date: "2027-03-11", status: "MISSING" }]);
  assert.equal(calendarNights({ transportError: true }).code, "CALENDAR_TRANSPORT_UNCERTAIN");
  const src = readFileSync(join(ROOT, "scripts/e4-recovery/precheck.mjs"), "utf8");
  for (const re of [/method: "(PUT|POST)"/, /statuses\/cancelled/, /priceDetails/, /createFileJournal|writeFileSync|appendFileSync|createWriteStream|mkdirSync|unlink|rmSync|renameSync/,
    /process\.env/, /console\./, /runRecovery\b/]) assert.doesNotMatch(src, re, String(re));
  assert.equal(globalFetchCalls, 0);
});
