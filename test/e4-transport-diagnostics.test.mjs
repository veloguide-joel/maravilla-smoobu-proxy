// E4 corrective (after the owner's 2026-10-23 HALTED run at P0_PREFLIGHT_PRICE / PRICE_TRANSPORT_UNCERTAIN): safe,
// allowlisted transport diagnostics + credential-prompt escape-sequence handling. Offline: mock git/prompt/fetch only;
// the global fetch is a throwing spy that must never be called. All "secrets" below are FAKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };

const { runHappyExecute, EXECUTE_SOURCES, EXIT } = await import("../scripts/e4-launcher/happy-execute.mjs");
const { validateHappyManifest } = await import("../scripts/e4-write-runner/happy-path.mjs");
const { createHostawayTransport } = await import("../scripts/e4-transport/hostaway-transport.mjs");
const { readHiddenLine } = await import("../scripts/e4-transport/credential-prompt.mjs");
const { sanitizeTransportDiag, sanitizeJournalEntry, createGate, TRANSPORT_DIAG_CODES } = await import("../scripts/e4-write-runner/runner.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "7192c2307f58861c2cfb4d71abcebb3f3614488f";
const FAKE_ACCOUNT = "98765";
const FAKE_SECRET = "FAKE-secret-DO-NOT-LEAK-111";
const FAKE_TOKEN = "FAKE-token-DO-NOT-LEAK-222";
const PROVIDER_TEXT = "PROVIDER-BODY-TEXT-DO-NOT-LEAK";
const MANIFEST = { manifestVersion: "e4-happy-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000, cleaningFeeMinor: 5000,
  guests: 2, window: { start: "2027-03-08", end: "2027-03-15" }, stay: { arrivalDate: "2027-03-10", departureDate: "2027-03-12" },
  guest: { firstName: "Joel", lastName: "Test", email: "Joel@veloguide.com" } };
const NOW = () => new Date("2026-10-23T00:00:00.000Z");
const TOKEN = validateHappyManifest(MANIFEST, { now: NOW }).confirmToken;
const REAL = spawnSync("git", ["hash-object", "--", ...EXECUTE_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
const git = (a) => (a[0] === "rev-parse" ? { status: 0, stdout: `${SHA}\n` } : a[0] === "status" ? { status: 0, stdout: "" }
  : a[0] === "ls-tree" ? { status: 0, stdout: EXECUTE_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: REAL.join("\n") });
const R = (s, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: s });
const LEAKS = [FAKE_ACCOUNT, FAKE_SECRET, FAKE_TOKEN, PROVIDER_TEXT, "Joel@veloguide.com", "fetch failed", "stack"];

async function runWith(handler) {
  const d = mkdtempSync(join(tmpdir(), "e4-diag-"));
  const m = join(d, "m.json"); writeFileSync(m, JSON.stringify(MANIFEST));
  const j = join(d, "journal"); mkdirSync(j);
  const calls = [];
  const r = await runHappyExecute([m, j, "--confirm", TOKEN, "--reviewed-commit", SHA], {
    git, now: NOW, prompt: async () => ({ accountId: FAKE_ACCOUNT, clientSecret: FAKE_SECRET }),
    fetchImpl: async (url, init = {}) => { calls.push({ path: new URL(String(url)).pathname, method: init.method }); return handler(new URL(String(url)).pathname, init); } });
  const files = readdirSync(j);
  const text = files.length ? readFileSync(join(j, files[0]), "utf8") : "";
  return { r, calls, text, entries: text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : [] };
}
const leakFree = (s, what) => { for (const x of LEAKS) assert.ok(!s.includes(x), `${what} leaks ${x}`); };

// ---------- the owner's signature, now with a precise, safe cause ----------
const TOKEN_FAILURES = [
  ["token HTTP 401", () => R(401, { status: "fail", message: `${PROVIDER_TEXT} ${FAKE_SECRET}` }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }],
  ["token HTTP 403", () => R(403, PROVIDER_TEXT), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 403 }],
  ["token HTTP 500", () => R(500, PROVIDER_TEXT), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 500 }],
  ["token 200 without access_token", () => R(200, { detail: PROVIDER_TEXT }), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
  ["token 200 not JSON", () => R(200, `<html>${PROVIDER_TEXT}</html>`), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
  ["token network: DNS", () => { throw Object.assign(new TypeError(`fetch failed ${FAKE_SECRET}`), { cause: { code: "ENOTFOUND", message: FAKE_SECRET } }); },
    { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ENOTFOUND" }],
  ["token network: corporate TLS", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } }); },
    { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }],
  ["token network: unlisted cause", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: `X_${FAKE_SECRET}` } }); },
    { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "UNLISTED" }],
  ["token timeout", () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); },
    { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "TIMEOUT", causeCode: "NONE" }]
];
for (const [name, tokenResponse, expected] of TOKEN_FAILURES) {
  test(`owner signature reproduced — ${name}: HALTED at P0, 0 writes, and now a precise safe diag`, async () => {
    const t0 = Date.now();
    const { r, calls, text, entries } = await runWith((path) => (path === "/v1/accessTokens" ? tokenResponse() : R(200, { status: "success", result: { totalPrice: 250 } })));
    // Same visible shape as the owner's journal/summary ...
    assert.deepEqual([r.exitCode, r.output.status, r.output.halt.step, r.output.halt.code], [EXIT.HALTED, "HALTED", "P0_PREFLIGHT_PRICE", "PRICE_TRANSPORT_UNCERTAIN"]);
    assert.deepEqual([r.output.writes, r.output.requests, r.output.steps, r.output.reconcile, r.output.sideEffectReads], [{ create: 0, cancel: 0 }, 1, [], [], 0]);
    assert.deepEqual(entries.map((e) => e.type), ["run-start", "read", "halt", "run-end"]);
    assert.ok(Date.now() - t0 < 1000, "a failed mint never waits for the 1100 ms activation delay");
    // ... plus WHY, safely:
    assert.deepEqual({ ...r.output.halt.diag }, expected);
    assert.deepEqual(entries.find((e) => e.type === "halt").diag, expected);
    assert.deepEqual(entries.find((e) => e.type === "read").diag, expected);
    assert.deepEqual(calls.map((c) => c.path), ["/v1/accessTokens"], "exactly one token request; no data request, no retry, no re-mint");
    leakFree(text, "journal"); leakFree(JSON.stringify(r.output), "summary");
  });
}

test("price request failures after a successful mint are distinct (HTTP status / network), still no writes", async () => {
  let res = await runWith((p) => (p === "/v1/accessTokens" ? R(200, { access_token: FAKE_TOKEN }) : R(500, PROVIDER_TEXT)));
  assert.deepEqual([res.r.output.halt.code, res.r.output.halt.httpStatus, res.r.output.halt.diag], ["PRICE_HTTP_NOT_OK", 500, undefined]);
  assert.equal(res.entries.find((e) => e.type === "read").httpStatus, 500);
  leakFree(res.text, "journal");
  res = await runWith((p) => { if (p === "/v1/accessTokens") return R(200, { access_token: FAKE_TOKEN }); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  assert.deepEqual([res.r.output.halt.code, { ...res.r.output.halt.diag }], ["PRICE_TRANSPORT_UNCERTAIN",
    { stage: "REQUEST", code: "REQUEST_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ECONNRESET" }]);
  assert.deepEqual(res.calls.map((c) => c.path), ["/v1/accessTokens", "/v1/listings/606998/calendar/priceDetails"]);
  leakFree(res.text, "journal"); leakFree(JSON.stringify(res.r.output), "summary");
});

test("transport: invalid local credentials send nothing and say so; a failed mint stays final with the same diag", async () => {
  let fetches = 0;
  const t = createHostawayTransport({ fetchImpl: async () => { fetches++; return R(200, {}); }, getCredentials: async () => ({ accountId: "12a", clientSecret: FAKE_SECRET }), sleep: async () => {} });
  const a = await t.send({ method: "GET", path: "/reservations/1" });
  const b = await t.send({ method: "GET", path: "/reservations/1" });
  assert.deepEqual([a.code, { ...a.diag }, b.diag.code, fetches], ["AUTH_UNAVAILABLE", { stage: "TOKEN", code: "TOKEN_LOCAL_INPUT_INVALID" }, "TOKEN_LOCAL_INPUT_INVALID", 0]);
  const t2 = createHostawayTransport({ fetchImpl: async () => { fetches++; return R(401, {}); }, getCredentials: async () => ({ accountId: FAKE_ACCOUNT, clientSecret: FAKE_SECRET }), sleep: async () => {} });
  await t2.send({ method: "GET", path: "/reservations/1" }); await t2.send({ method: "GET", path: "/reservations/1" });
  assert.equal(fetches, 1, "one mint attempt only; no retry, no re-mint");
});

test("allowlist: every code the transport and gate can emit survives sanitizing; anything else (or extra keys/text) is dropped", async () => {
  for (const code of TRANSPORT_DIAG_CODES) {
    const stage = code.startsWith("TOKEN") ? "TOKEN" : code.startsWith("REQUEST") ? "REQUEST" : "GATE";
    assert.deepEqual({ ...sanitizeTransportDiag({ stage, code }) }, { stage, code });
  }
  const hostile = { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401, message: FAKE_SECRET, body: PROVIDER_TEXT, errorKind: FAKE_SECRET, causeCode: FAKE_TOKEN, accountId: FAKE_ACCOUNT };
  assert.deepEqual({ ...sanitizeTransportDiag(hostile) }, { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 });
  for (const bad of [null, "x", { stage: "TOKEN" }, { stage: "X", code: "TOKEN_HTTP_REFUSED" }, { stage: "TOKEN", code: FAKE_SECRET }]) assert.equal(sanitizeTransportDiag(bad), null);
  assert.deepEqual(sanitizeJournalEntry({ type: "halt", step: "P0_PREFLIGHT_PRICE", code: "PRICE_TRANSPORT_UNCERTAIN", diag: hostile }).diag,
    { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 });
  // The gate re-sanitizes whatever a transport returns.
  const gate = createGate({ transport: { send: async () => ({ transportError: true, code: "X", diag: hostile }) }, journal: { load: () => [], append() {} }, timeoutMs: 50,
    state: { halted: false, readOnly: false, readableIds: new Set(), cancellableId: null } });
  const g = await gate.send("S0_PREFLIGHT_PRICE", { method: "POST", path: "/listings/606998/calendar/priceDetails", query: {}, body: {} });
  assert.deepEqual([g.code, { ...g.diag }], ["TRANSPORT_ERROR", { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }]);
  const slow = createGate({ transport: { send: () => new Promise(() => {}) }, journal: { load: () => [], append() {} }, timeoutMs: 20,
    state: { halted: false, readOnly: false, readableIds: new Set(), cancellableId: null } });
  const to = await slow.send("S0_PREFLIGHT_PRICE", { method: "POST", path: "/listings/606998/calendar/priceDetails", query: {}, body: {} });
  assert.deepEqual([to.code, { ...to.diag }], ["TIMEOUT", { stage: "GATE", code: "GATE_TIMEOUT" }]);
});

// ---------- credential prompt: escape sequences are never part of the value ----------
function tty() {
  const input = new EventEmitter();
  input.isTTY = true; input.setRawMode = () => {}; input.resume = () => {}; input.pause = () => {};
  return input;
}
async function typed(chunks) {
  const input = tty();
  const written = [];
  const p = readHiddenLine({ input, output: { write: (s) => written.push(String(s)) }, label: "x" });
  for (const c of chunks) input.emit("data", Buffer.from(c));
  const v = await p;
  return { v, written: written.join("") };
}
test("prompt: bracketed paste markers, arrow/function keys and Alt-sequences are dropped; plain input unchanged", async () => {
  assert.equal((await typed(["\x1b[200~FAKEsecret123\x1b[201~", "\r"])).v, "FAKEsecret123", "bracketed paste");
  assert.equal((await typed(["\x1b[200~FAKEsec", "ret123\x1b[2", "01~\r"])).v, "FAKEsecret123", "markers split across chunks");
  assert.equal((await typed(["FAKE\x1b[Dsec\x1b[1;5Cret\r"])).v, "FAKEsecret", "arrow / ctrl-arrow");
  assert.equal((await typed(["FAKE\x1bOPsecret\r"])).v, "FAKEsecret", "SS3 function key");
  assert.equal((await typed(["FAKE\x1bxsecret\r"])).v, "FAKEsecret", "Alt+key");
  assert.equal((await typed(["FAKEsecX\x7fret\r\n"])).v, "FAKEsecret", "backspace + CRLF unchanged");
  assert.equal((await typed(["98765\r"])).v, "98765");
  assert.ok(!(await typed(["\x1b[200~FAKEsecret123\x1b[201~\r"])).written.includes("FAKE"), "still never echoed");
});

test("no global fetch was used by any test in this file", () => { assert.equal(globalFetchCalls, 0); });
