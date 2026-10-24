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
    tasks: over.tasks ?? [], charges: over.charges ?? [], convCount: over.convCount, calStatus: over.calStatus ?? "reserved",
    calAvail: Object.prototype.hasOwnProperty.call(over, "calAvail") ? over.calAvail : [0, 0], calDays: over.calDays };
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
    if (method === "GET" && path === "/listings/606998/calendar") {
      const day = (date, i) => { const d = { date, status: w.calStatus, note: "PROVIDER-TEXT" }; if (w.calAvail[i] !== "absent") d.isAvailable = w.calAvail[i]; return d; };
      return ok(w.calDays ?? ["2027-03-10", "2027-03-11"].map(day));
    }
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
    [{ calStatus: "available" }, (o) => o.precheckComplete && !o.baselineMatches],
    // root's reproduction: reserved but isAvailable true must NOT match the baseline
    [{ calAvail: [true, true] }, (o) => o.precheckComplete && !o.baselineMatches && o.calendar.nights.every((n) => n.isAvailable === true)],
    [{ calAvail: [1, 0] }, (o) => o.precheckComplete && !o.baselineMatches],
    [{ calAvail: [null, 0] }, (o) => o.precheckComplete && !o.baselineMatches && o.calendar.nights[0].isAvailable === null],
    [{ calAvail: ["absent", 0] }, (o) => o.precheckComplete && !o.baselineMatches && o.calendar.nights[0].isAvailable === null],
    [{ calAvail: ["0", 0] }, (o) => o.precheckComplete && !o.baselineMatches],
    [{ calDays: [{ date: "2027-03-10", status: "reserved", isAvailable: 0 }] }, (o) => !o.precheckComplete && !o.baselineMatches && o.calendar.code === "CALENDAR_DAYS_MISSING"],
    [{ calAvail: [false, false] }, (o) => o.precheckComplete && o.baselineMatches]
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

// ---------- owner run 2026-10-23 (exit 3): the reported signature, and why the new diagnostic is needed ----------
// Owner-reported (relayed by root): identity READ_TRANSPORT_UNCERTAIN, lookup TRANSPORT_UNCERTAIN, charges/conversations/
// tasks/calendar *_TRANSPORT_UNCERTAIN (pagesRead 0), requests 6, guard {token:1, all reads 0, refused:0}.
const OWNER_SIGNATURE = {
  identity: { code: "READ_TRANSPORT_UNCERTAIN" }, lookup: { code: "TRANSPORT_UNCERTAIN", sameId: false }, charges: "CHARGES_TRANSPORT_UNCERTAIN",
  conversations: { code: "CONVERSATIONS_TRANSPORT_UNCERTAIN", pagesRead: 0 }, tasks: { code: "TASKS_TRANSPORT_UNCERTAIN", pagesRead: 0 },
  calendar: { code: "CALENDAR_TRANSPORT_UNCERTAIN" }, precheckComplete: false, baselineMatches: false, requests: 6,
  guard: { token: 1, read: 0, lookup: 0, charges: 0, conversations: 0, tasks: 0, calendar: 0, refused: 0 }
};
const pickOld = (o) => ({ identity: o.identity, lookup: o.lookup, charges: o.charges, conversations: o.conversations, tasks: o.tasks,
  calendar: o.calendar, precheckComplete: o.precheckComplete, baselineMatches: o.baselineMatches, requests: o.requests, guard: o.guard });
const mintFailures = [
  ["token 401", async () => new Response(JSON.stringify({ status: "fail", result: "PROVIDER-TEXT" }), { status: 401 }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }],
  ["token 403", async () => new Response("PROVIDER-TEXT", { status: 403 }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 403 }],
  ["token 429", async () => new Response("PROVIDER-TEXT", { status: 429 }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 429 }],
  ["token 500", async () => new Response("PROVIDER-TEXT", { status: 500 }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 500 }],
  ["token 200 without access_token", async () => new Response(JSON.stringify({ status: "success", result: "PROVIDER-TEXT" }), { status: 200 }), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
  ["token 200 non-JSON", async () => new Response("<html>PROVIDER-TEXT</html>", { status: 200 }), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
  ["DNS failure", async () => { throw Object.assign(new TypeError("fetch failed PROVIDER-TEXT"), { cause: { code: "ENOTFOUND" } }); }, { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ENOTFOUND" }],
  ["TLS interception", async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }); }, { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "SELF_SIGNED_CERT_IN_CHAIN" }],
  ["fetch timeout", async () => { throw Object.assign(new Error("PROVIDER-TEXT"), { name: "TimeoutError" }); }, { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "TIMEOUT", causeCode: "NONE" }],
  ["unlisted cause", async () => { throw Object.assign(new TypeError("x"), { cause: { code: "EWHATEVER" } }); }, { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "UNLISTED" }]
];
test("owner exit-3 signature: EVERY mint-failure class yields the identical old output; only transportDiag tells them apart", async () => {
  const seen = new Set();
  for (const [name, tokenReply, wantDiag] of mintFailures) {
    const f = folder(); const before = snap(f.dir); const calls = [];
    const fetchImpl = async (url, init = {}) => { calls.push(`${init.method ?? "GET"} ${new URL(String(url)).pathname}`); return tokenReply(); };
    const r = await runPrecheckCli(["--precheck", "--journal-dir", f.jdir, "--reviewed-commit", SHA], { git: git(), fetchImpl, sleep: async () => {}, timeoutMs: 500,
      prompt: async () => ({ accountId: FAKE.account, clientSecret: FAKE.secret }) });
    assert.equal(r.exitCode, PRECHECK_EXIT.INCOMPLETE, name);
    assert.deepEqual(pickOld(r.output), OWNER_SIGNATURE, `${name}: old fields reproduce the owner's signature exactly`);
    assert.deepEqual(r.output.transportDiag, wantDiag, name);
    assert.deepEqual(r.output.transportUsage, { mintState: "failed", fetches: 1 }, name);
    assert.deepEqual(calls, ["POST /v1/accessTokens"], `${name}: exactly one fetch, the mint; no GET reached fetch`);
    assert.deepEqual(snap(f.dir), before, `${name}: nothing written`);
    leakFree(r.output);
    seen.add(JSON.stringify(wantDiag));
  }
  // 9 distinct diagnostics for 10 cases: both 200-without-token shapes are intentionally one class (TOKEN_RESPONSE_INVALID/200);
  // no body detail is exposed to tell them apart.
  assert.equal(seen.size, 9, "every class except the two 200-response shapes has a distinct diagnostic");
});

test("malformed credential input never reaches fetch (guard token 0): excluded by the owner's token:1", async () => {
  for (const creds of [{ accountId: "", clientSecret: FAKE.secret }, { accountId: "12a", clientSecret: FAKE.secret }, { accountId: FAKE.account, clientSecret: "" }]) {
    const f = folder(); let fetched = 0;
    const r = await runPrecheckCli(["--precheck", "--journal-dir", f.jdir, "--reviewed-commit", SHA], { git: git(), fetchImpl: async () => { fetched++; },
      sleep: async () => {}, timeoutMs: 500, prompt: async () => creds });
    assert.deepEqual([fetched, r.output.guard.token, r.output.transportDiag, r.output.transportUsage], [0, 0, { stage: "TOKEN", code: "TOKEN_LOCAL_INPUT_INVALID" }, { mintState: "failed", fetches: 0 }]);
    assert.notDeepEqual(pickOld(r.output), OWNER_SIGNATURE);
  }
});

test("success path: transportDiag null, mint ok; fetch count = mint + reads", async () => {
  const f = folder(); const w = world();
  const r = await runPrecheckCli(["--precheck", "--journal-dir", f.jdir, "--reviewed-commit", SHA], { git: git(), fetchImpl: w.fetchImpl, sleep: async () => {},
    timeoutMs: 500, prompt: async () => ({ accountId: FAKE.account, clientSecret: FAKE.secret }) });
  assert.deepEqual([r.exitCode, r.output.transportDiag, r.output.transportUsage.mintState], [PRECHECK_EXIT.OK, null, "ok"]);
  assert.equal(r.output.transportUsage.fetches, w.log.length, "every fetch counted (token + GETs)");
  // a REQUEST-stage failure after a good mint is reported as such (first failure only)
  const w2 = world(); const inner = w2.fetchImpl; let n = 0;
  const flaky = async (url, init) => { if (String(url).includes("/reservations/70636076")) { n++; throw Object.assign(new TypeError("x"), { cause: { code: "ECONNRESET" } }); } return inner(url, init); };
  const r2 = await runPrecheckCli(["--precheck", "--journal-dir", folder().jdir, "--reviewed-commit", SHA], { git: git(), fetchImpl: flaky, sleep: async () => {},
    timeoutMs: 500, prompt: async () => ({ accountId: FAKE.account, clientSecret: FAKE.secret }) });
  assert.deepEqual([n, r2.output.transportDiag], [1, { stage: "REQUEST", code: "REQUEST_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ECONNRESET" }]);
  assert.equal(r2.output.transportUsage.mintState, "ok");
});

test("transportDiag is allowlist-only: hostile diag fields are dropped", async () => {
  const hostile = { send: async () => ({ transportError: true, diag: { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401, message: "PROVIDER-TEXT", url: "https://x", accountId: FAKE.account, token: FAKE.token } }),
    usage: () => ({ mintState: "failed", fetches: 1, secret: FAKE.secret }) };
  const o = await runPrecheck({ transport: hostile, timeoutMs: 100 });
  assert.deepEqual([o.transportDiag, o.transportUsage], [{ stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }, { mintState: "failed", fetches: 1 }]);
  leakFree(o);
  const weird = { send: async () => ({ transportError: true, diag: { stage: "X", code: "Y" } }), usage: () => ({ mintState: "weird", fetches: -1 }) };
  const o2 = await runPrecheck({ transport: weird, timeoutMs: 100 });
  assert.deepEqual([o2.transportDiag, o2.transportUsage], [null, null]);
});

test("timeouts are reported as GATE_TIMEOUT (gate path and direct reads alike); first failure wins", async () => {
  const hang = { send: () => new Promise(() => {}), usage: () => ({ mintState: "ok", fetches: 3 }) };
  const o = await runPrecheck({ transport: hang, timeoutMs: 20 });
  assert.deepEqual([o.transportDiag, o.transportUsage, o.identity.code, o.charges], [{ stage: "GATE", code: "GATE_TIMEOUT" }, { mintState: "ok", fetches: 3 }, "READ_TRANSPORT_UNCERTAIN", "CHARGES_TRANSPORT_UNCERTAIN"]);
  // identity/lookup succeed-as-transport (no transportError), the first direct read hangs: still GATE_TIMEOUT from the direct path
  const direct = { send: (req) => req.path === "/guestPayments/charges" ? new Promise(() => {}) : Promise.resolve({ httpStatus: 503 }) };
  const o2 = await runPrecheck({ transport: direct, timeoutMs: 20 });
  assert.deepEqual([o2.transportDiag, o2.transportUsage], [{ stage: "GATE", code: "GATE_TIMEOUT" }, null]);
  // a later different failure never overwrites the first
  let k = 0;
  const seq = { send: async () => ({ transportError: true, diag: k++ === 0 ? { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 } : { stage: "REQUEST", code: "REQUEST_NETWORK_FAILED", errorKind: "TIMEOUT", causeCode: "NONE" } }) };
  const o3 = await runPrecheck({ transport: seq, timeoutMs: 20 });
  assert.ok(k >= 6);
  assert.deepEqual(o3.transportDiag, { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 });
});

test("diagnostic capture covers every read path: identity gate timeout, lookup inside the gate, direct throw; usage fields checked individually", async () => {
  const X = { stage: "REQUEST", code: "REQUEST_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ECONNRESET" };
  const Y = { stage: "REQUEST", code: "REQUEST_BODY_READ_FAILED" };
  // identity hangs in the gate (gate-synthesized GATE_TIMEOUT) and is the first failure; later failures carry X
  const a = { send: (req) => req.path === "/reservations/70636076" ? new Promise(() => {}) : Promise.resolve({ transportError: true, diag: X }) };
  assert.deepEqual((await runPrecheck({ transport: a, timeoutMs: 20 })).transportDiag, { stage: "GATE", code: "GATE_TIMEOUT" });
  // identity is a non-transport HTTP reply; the lookup page (sent by reconcileAttempts through the gate) is the first failure
  const b = { send: async (req) => req.path === "/reservations/70636076" ? { httpStatus: 503 } : req.path === "/reservations" ? { transportError: true, diag: X } : { transportError: true, diag: Y } };
  assert.deepEqual((await runPrecheck({ transport: b, timeoutMs: 20 })).transportDiag, X);
  // a throwing transport on a direct read is reported as TRANSPORT_THREW (never the error text)
  const c = { send: (req) => req.path.startsWith("/reservations") ? Promise.resolve({ httpStatus: 503 }) : Promise.reject(new Error("PROVIDER-TEXT")) };
  const oc = await runPrecheck({ transport: c, timeoutMs: 20 });
  assert.deepEqual(oc.transportDiag, { stage: "GATE", code: "TRANSPORT_THREW" }); leakFree(oc);
  for (const [u, want] of [[{ mintState: "weird", fetches: 1 }, null], [{ mintState: "ok", fetches: 101 }, null], [{ mintState: "ok", fetches: -1 }, null],
    [{ mintState: "ok", fetches: 1.5 }, null], [{ mintState: "ok", fetches: "1" }, null], [{ mintState: "none", fetches: 0 }, { mintState: "none", fetches: 0 }],
    [{ mintState: "ok", fetches: 100 }, { mintState: "ok", fetches: 100 }]]) {
    const o = await runPrecheck({ transport: { send: async () => ({ httpStatus: 503 }), usage: () => u }, timeoutMs: 20 });
    assert.deepEqual(o.transportUsage, want, JSON.stringify(u));
  }
  const thrower = await runPrecheck({ transport: { send: async () => ({ httpStatus: 503 }), usage: () => { throw new Error("PROVIDER-TEXT"); } }, timeoutMs: 20 });
  assert.equal(thrower.transportUsage, null); leakFree(thrower);
});

// ---------- root review of aa3b1ae: gate-synthesized failures on the LOOKUP path (inside reconcileAttempts) ----------
const { createHostawayTransport } = await import("../scripts/e4-transport/hostaway-transport.mjs");
function lookupFaultTransport(fault) {
  const w = world();
  const real = createHostawayTransport({ fetchImpl: w.fetchImpl, getCredentials: async () => ({ accountId: FAKE.account, clientSecret: FAKE.secret }), sleep: async () => {} });
  const calls = [];
  const t = { send: (req) => { calls.push(req.path); return req.path === "/reservations" ? fault() : real.send(req); }, usage: () => real.usage() };
  return { t, calls };
}
for (const [name, fault, want] of [
  ["hang (gate GATE_TIMEOUT)", () => new Promise(() => {}), { stage: "GATE", code: "GATE_TIMEOUT" }],
  ["reject (gate TRANSPORT_THREW)", () => Promise.reject(new Error("PROVIDER-TEXT")), { stage: "GATE", code: "TRANSPORT_THREW" }],
  // A SYNCHRONOUS throw escapes createGate as an exception (its withTimeout factory rejects before the TRANSPORT_THREW
  // handler is attached); reconcileAttempts absorbs it as TRANSPORT_UNCERTAIN. There is no gate result to note, so no
  // diagnostic is invented. The real transport's send is `async` and cannot throw synchronously.
  ["sync throw (escapes the gate; no diagnostic invented)", () => { throw new Error("PROVIDER-TEXT"); }, null]]) {
  test(`lookup-only ${name}: identity ok, later reads ok, transportDiag as specified`, async () => {
    const { t, calls } = lookupFaultTransport(fault);
    const o = await runPrecheck({ transport: t, timeoutMs: 50 });
    assert.equal(o.identity.code, "IDENTITY_OK");
    assert.equal(o.lookup.sameId, false);
    assert.equal(o.lookup.code, "TRANSPORT_UNCERTAIN");
    assert.deepEqual([o.charges, o.conversations.code, o.tasks.code, o.calendar.code], ["CHARGES_NONE", "CONVERSATIONS_COMPLETE", "TASKS_COMPLETE", "CALENDAR_READ"]);
    assert.deepEqual(o.transportDiag, want);
    assert.deepEqual(o.transportUsage.mintState, "ok");
    assert.equal(calls.filter((p) => p === "/reservations").length, 1, "one lookup page sent; no retry");
    assert.equal(o.requests, calls.length, "every runner-level call reached the transport exactly once (requests unchanged by decoration)");
    assert.equal(o.precheckComplete, false);
    leakFree(o);
  });
}
