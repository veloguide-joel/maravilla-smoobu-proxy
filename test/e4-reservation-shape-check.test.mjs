// E4 reservation shape check — offline. Mock git/prompt/fetch; FAKE secrets; synthetic payloads (NOT provider evidence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };
const { runShapeCheck, guardFetch, describeId, SHAPE_SOURCES, SHAPE_EXIT, DIRECT_CHANNEL_ID, RESERVATION_STATUSES } = await import("../scripts/e4-launcher/reservation-shape-check.mjs");
const adapter = await import("../lib/hostaway-reservations.js");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "d".repeat(40);
const TOKEN_URL = "https://api.hostaway.com/v1/accessTokens";
const READ_URL = "https://api.hostaway.com/v1/reservations/70636076?includeResources=1";
const FAKE = { account: "98765", secret: "FAKE-secret-DO-NOT-LEAK", token: "FAKE-token-DO-NOT-LEAK" };
const CHANNEL_RES = "98765-606998-2000-1111111111";
const BASE = { id: 70636076, hostawayReservationId: 70636076, listingMapId: 606998, channelId: 2000, reservationId: CHANNEL_RES,
  arrivalDate: "2027-03-10", departureDate: "2027-03-12", totalPrice: 250, currency: "USD", status: "new",
  guestName: "Joel Test", guestEmail: "Joel@veloguide.com", guestPhone: "+15555550123", hostNote: "PROVIDER-TEXT",
  customFieldValues: [{ customFieldId: 105433, value: "MV-OTHL9CQU" }, { customFieldId: 1, value: "OTHER-FIELD-TEXT" }] };
const LEAKS = [FAKE.account, FAKE.secret, FAKE.token, CHANNEL_RES, "Joel", "veloguide", "5555550123", "PROVIDER-TEXT", "OTHER-FIELD-TEXT"];
const REAL = spawnSync("git", ["hash-object", "--", ...SHAPE_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
const git = (opt = {}) => (a) => a[0] === "rev-parse" ? { status: 0, stdout: `${opt.head ?? SHA}\n` } : a[0] === "status" ? { status: 0, stdout: opt.dirty ?? "" }
  : a[0] === "ls-tree" ? { status: 0, stdout: SHAPE_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: REAL.join("\n") };
const R = (s, b) => new Response(typeof b === "string" ? b : JSON.stringify(b), { status: s });
async function run(read, { token = () => R(200, { access_token: FAKE.token }), g = git(), prompt } = {}) {
  const calls = [];
  let prompts = 0;
  const fetchImpl = async (u, init = {}) => { calls.push(`${init.method} ${String(u)}`); return String(u) === TOKEN_URL ? token() : read(); };
  const r = await runShapeCheck(["--reviewed-commit", SHA], { git: g, fetchImpl, sleep: async () => {},
    prompt: prompt ?? (async () => { prompts++; return { accountId: FAKE.account, clientSecret: FAKE.secret }; }) });
  return { r, calls, prompts };
}
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `leak: ${x}`); };
const ok = (over) => () => R(200, { status: "success", result: { ...BASE, ...over } });

test("refusals before prompt/network: usage, bad sha, provenance (head/dirty/blob); aborted prompt sends nothing", async () => {
  for (const argv of [[], ["--reviewed-commit"], ["--x", SHA], ["--reviewed-commit", "ABC"]]) {
    let f = 0; const r = await runShapeCheck(argv, { git: git(), fetchImpl: async () => { f++; }, prompt: async () => { throw new Error("no"); } });
    assert.deepEqual([r.exitCode, f], [SHAPE_EXIT.USAGE, 0]);
  }
  for (const g of [git({ head: "e".repeat(40) }), git({ dirty: " M x\n" })]) {
    const { r, calls, prompts } = await run(ok(), { g });
    assert.deepEqual([r.exitCode, r.output.stage, calls.length, prompts], [SHAPE_EXIT.REFUSED, "provenance", 0, 0]);
  }
  const { r, calls } = await run(ok(), { prompt: async () => { throw Object.assign(new Error(), { code: "ABORTED" }); } });
  assert.deepEqual([r.output.stage, r.output.error, calls.length], ["credentials", "ABORTED", 0]);
  assert.ok(SHAPE_SOURCES.includes("scripts/e4-launcher/reservation-shape-check.mjs"));
});

test("exactly one token POST then one GET of the fixed reservation URL; integer alias equal => ok with safe values only", async () => {
  const { r, calls } = await run(ok());
  assert.deepEqual(calls, [`POST ${TOKEN_URL}`, `GET ${READ_URL}`]);
  assert.deepEqual([r.exitCode, r.output.ok, r.output.identityOk, r.output.requests], [SHAPE_EXIT.OK, true, true, { token: 1, read: 1 }]);
  assert.deepEqual(r.output.shape.id, { type: "integer", value: 70636076 });
  assert.deepEqual(r.output.shape.hostawayReservationId, { type: "integer", value: 70636076 });
  assert.deepEqual([r.output.shape.aliasStrictEqualsId, r.output.shape.aliasNumericEqualsId], [true, true]);
  assert.deepEqual([r.output.status, r.output.totalMinorMatches, r.output.currencyMatches, r.output.checks.channelDirect], ["new", true, true, true]);
  leakFree(r.output);
});

test("alias variants are reported precisely: digit string, null, absent, different, non-digit string", async () => {
  const cases = [
    [{ hostawayReservationId: "70636076" }, { type: "string-digits", value: "70636076" }, false, true],
    [{ hostawayReservationId: null }, { type: "null" }, false, false],
    [{ hostawayReservationId: undefined }, { type: "absent" }, false, false],
    [{ hostawayReservationId: 70636077 }, { type: "integer", value: 70636077 }, false, false],
    [{ hostawayReservationId: "HA-70636076" }, { type: "string-other" }, false, false]
  ];
  for (const [over, ok2] of [[{ totalPrice: "250" }, false], [{ totalPrice: 250.01 }, false], [{ totalPrice: 250.0 }, true]]) {
    const { r } = await run(ok(over)); assert.equal(r.output.totalMinorMatches, ok2, JSON.stringify(over));
  }
  for (const [over, alias, strict, numeric] of cases) {
    const { r } = await run(ok(over));
    assert.deepEqual([r.output.identityOk, r.output.shape.hostawayReservationId, r.output.shape.aliasStrictEqualsId, r.output.shape.aliasNumericEqualsId],
      [true, alias, strict, numeric], JSON.stringify(over));
    leakFree(r.output);
  }
  const { r } = await run(ok({ id: "70636076" }));
  assert.deepEqual([r.output.identityOk, r.output.shape.id], [true, { type: "string-digits", value: "70636076" }]);
});

test("wrong reservation / listing / ref / dates: identity gate => no id values, no status/amount, exit 3", async () => {
  for (const over of [{ id: 70000001, hostawayReservationId: 70000001 }, { listingMapId: 603564 }, { customFieldValues: [{ customFieldId: 105433, value: "MV-ZZZZZZZZ" }] },
    { customFieldValues: [] }, { customFieldValues: [{ customFieldId: 105433, value: "MV-OTHL9CQU" }, { customFieldId: 105433, value: "MV-OTHL9CQU" }] }, { departureDate: "2027-03-13" }]) {
    const { r } = await run(ok(over));
    assert.deepEqual([r.exitCode, r.output.ok, r.output.identityOk], [SHAPE_EXIT.DIAGNOSED_FAILURE, false, false], JSON.stringify(over));
    assert.equal("value" in r.output.shape.id, false);
    assert.equal("value" in r.output.shape.hostawayReservationId, false);
    assert.equal("status" in r.output, false);
    leakFree(r.output);
  }
});

test("token/read failures: fixed codes only, nothing from the provider body", async () => {
  const t401 = await run(ok(), { token: () => R(401, { message: `PROVIDER-TEXT ${FAKE.secret}` }) });
  assert.deepEqual([t401.r.exitCode, t401.r.output.tokenOk, t401.r.output.diag.code, t401.r.output.requests], [SHAPE_EXIT.DIAGNOSED_FAILURE, false, "TOKEN_HTTP_REFUSED", { token: 1, read: 0 }]);
  for (const [read, code] of [[() => R(404, "PROVIDER-TEXT"), "READ_HTTP_NOT_OK"], [() => R(200, { status: "fail", result: "PROVIDER-TEXT" }), "READ_ENVELOPE_INVALID"],
    [() => R(200, { status: "success", result: ["x"] }), "READ_RESULT_NOT_OBJECT"]]) {
    const { r } = await run(read);
    assert.deepEqual([r.output.tokenOk, r.output.readOk, r.output.readCode], [true, false, code]);
    leakFree(r.output);
  }
  const net = await run(() => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  assert.deepEqual([net.r.output.tokenOk, net.r.output.diag.code], [true, "REQUEST_NETWORK_FAILED"]);
  leakFree(t401.r.output);
});

test("guard: every other method/path/query/body/second call is refused before fetch", async () => {
  let inner = 0;
  const g = guardFetch(async () => { inner++; return R(200, {}); });
  const go = async (u, init) => { try { await g.guarded(u, init); return "SENT"; } catch (e) { return e.name; } };
  for (const [u, init] of [["https://api.hostaway.com/v1/reservations/70636076/statuses/cancelled", { method: "PUT", body: "{}" }],
    ["https://api.hostaway.com/v1/reservations/70636076?includeResources=1", { method: "PUT", body: "{}" }],
    ["https://api.hostaway.com/v1/reservations/70636076", { method: "GET" }], ["https://api.hostaway.com/v1/reservations", { method: "POST", body: "{}" }],
    ["https://api.hostaway.com/v1/reservations/70636077?includeResources=1", { method: "GET" }], [READ_URL, { method: "GET", body: "x" }], [READ_URL, { method: "DELETE" }], [READ_URL, { method: "PUT" }],
    ["https://api.hostaway.com/v1/conversations?reservationId=70636076", { method: "GET" }], ["https://api.hostaway.com/v1/listings/606998", { method: "GET" }]]) {
    assert.equal(await go(u, init), "LocalRefusal", `${init.method} ${u}`);
  }
  assert.equal(inner, 0);
  assert.deepEqual([await go(TOKEN_URL, { method: "POST", body: "x" }), await go(TOKEN_URL, { method: "POST", body: "x" }),
    await go(READ_URL, { method: "GET" }), await go(READ_URL, { method: "GET" })], ["SENT", "LocalRefusal", "SENT", "LocalRefusal"]);
  assert.deepEqual(g.used(), { token: 1, read: 1, refused: 12 });
  assert.deepEqual(describeId(7.5, true), { type: "number-other" });
  assert.deepEqual([DIRECT_CHANNEL_ID, [...RESERVATION_STATUSES]], [adapter.DIRECT_CHANNEL_ID, [...adapter.RESERVATION_STATUSES]], "local copies equal the adapter");
});

test("no files written; source is read-only by construction; global fetch never used", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e4-shape-")); const cwd = process.cwd(); process.chdir(dir);
  try { await run(ok()); } finally { process.chdir(cwd); }
  assert.deepEqual(readdirSync(dir), []);
  const src = readFileSync(join(ROOT, "scripts/e4-launcher/reservation-shape-check.mjs"), "utf8");
  for (const re of [/writeFileSync|appendFileSync|createWriteStream|openSync|mkdirSync|unlink|rmSync|renameSync/, /createFileJournal|readJournalFile|executeHappyRun|runHappyExecute/,
    /statuses\/cancelled|priceDetails|method: "(POST|PUT)"/, /process\.env/, /console\./]) assert.doesNotMatch(src, re, String(re));
  assert.equal(globalFetchCalls, 0);
});
