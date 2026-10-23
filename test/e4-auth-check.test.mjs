// E4 auth + read-only diagnostic (scripts/e4-launcher/auth-check.mjs) — offline. Mock git/prompt/fetch only; no real
// credentials or network. The global fetch is a throwing spy that must never be called. All "secrets" are FAKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };

const { runAuthCheck, guardFetch, AUTH_CHECK_SOURCES, AUTH_EXIT } = await import("../scripts/e4-launcher/auth-check.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "b".repeat(40);
const FAKE_ACCOUNT = "98765";
const FAKE_SECRET = "FAKE-secret-DO-NOT-LEAK-111";
const FAKE_TOKEN = "FAKE-token-DO-NOT-LEAK-222";
const PROVIDER_TEXT = "PROVIDER-TEXT-DO-NOT-LEAK";
const LISTING_DATA = { id: 606998, name: "maraVilla TEST - DO NOT BOOK.", address: "SECRET-ADDRESS", contactName: "Joel Test", contactEmail: "Joel@veloguide.com" };
const LEAKS = [FAKE_ACCOUNT, FAKE_SECRET, FAKE_TOKEN, PROVIDER_TEXT, "SECRET-ADDRESS", "Joel Test", "Joel@veloguide.com", "maraVilla TEST"];
const TOKEN_URL = "https://api.hostaway.com/v1/accessTokens";
const LISTING_URL = "https://api.hostaway.com/v1/listings/606998";
const REAL = spawnSync("git", ["hash-object", "--", ...AUTH_CHECK_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
function fakeGit({ head = SHA, dirty = "", hashes = REAL } = {}) {
  const calls = [];
  const git = (a) => { calls.push(a[0]);
    return a[0] === "rev-parse" ? { status: 0, stdout: `${head}\n` } : a[0] === "status" ? { status: 0, stdout: dirty }
      : a[0] === "ls-tree" ? { status: 0, stdout: AUTH_CHECK_SOURCES.map((p, i) => `100644 blob ${REAL[i]}\t${p}`).join("\n") } : { status: 0, stdout: hashes.join("\n") }; };
  return { git, calls };
}
const R = (s, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: s });
function promptSpy(result = { accountId: FAKE_ACCOUNT, clientSecret: FAKE_SECRET }) {
  const s = { calls: 0 };
  s.prompt = async () => { s.calls++; if (result instanceof Error) throw result; return Object.freeze({ ...result }); };
  return s;
}
async function run(handler, { git = fakeGit().git, prompt = promptSpy() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), method: init.method, body: init.body, auth: init.headers?.Authorization }); return handler(String(url), init); };
  const r = await runAuthCheck(["--reviewed-commit", SHA], { git, prompt: prompt.prompt, fetchImpl, sleep: async () => {} });
  return { r, calls, prompt };
}
const leakFree = (o) => { const s = JSON.stringify(o); for (const x of LEAKS) assert.ok(!s.includes(x), `output leaks ${x}`); };

// ---------- refusals before any prompt or network ----------
test("arguments and provenance: refused with zero prompts and zero fetches", async () => {
  for (const [argv, code] of [[[], "USAGE"], [["--reviewed-commit"], "USAGE"], [["--reviewed-commit", SHA, "--x"], "USAGE"], [["--commit", SHA], "USAGE"],
    [["--reviewed-commit", "abc"], "REVIEWED_COMMIT_INVALID"], [["--reviewed-commit", SHA.toUpperCase()], "REVIEWED_COMMIT_INVALID"]]) {
    const p = promptSpy(); let f = 0;
    const r = await runAuthCheck(argv, { git: fakeGit().git, prompt: p.prompt, fetchImpl: async () => { f++; } });
    assert.deepEqual([r.exitCode, r.output.error, p.calls, f], [AUTH_EXIT.USAGE, code, 0, 0], JSON.stringify(argv));
  }
  for (const [opt, code] of [[{ head: "c".repeat(40) }, "HEAD_NOT_REVIEWED_COMMIT"], [{ dirty: " M scripts/e4-launcher/auth-check.mjs\n" }, "SOURCE_DIRTY"],
    [{ hashes: REAL.map((h, i) => (i === REAL.length - 1 ? "0".repeat(40) : h)) }, "SOURCE_MISMATCH:scripts/e4-launcher/auth-check.mjs"]]) {
    const p = promptSpy(); let f = 0;
    const r = await runAuthCheck(["--reviewed-commit", SHA], { git: fakeGit(opt).git, prompt: p.prompt, fetchImpl: async () => { f++; } });
    assert.deepEqual([r.exitCode, r.output.stage, r.output.error, r.output.network, p.calls, f], [AUTH_EXIT.REFUSED, "provenance", code, "none", 0, 0], code);
  }
  assert.ok(AUTH_CHECK_SOURCES.includes("scripts/e4-launcher/auth-check.mjs"));
});

test("an aborted prompt sends nothing", async () => {
  const { r, calls } = await run(() => R(200, {}), { prompt: promptSpy(Object.assign(new Error("x"), { code: "ABORTED" })) });
  assert.deepEqual([r.exitCode, r.output.stage, r.output.error, calls.length], [AUTH_EXIT.REFUSED, "credentials", "ABORTED", 0]);
});

// ---------- diagnosed outcomes ----------
test("token refused / malformed reply / network error: precise safe diag; the listing is never requested", async () => {
  const cases = [
    [() => R(401, { message: `${PROVIDER_TEXT} ${FAKE_SECRET}` }), { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 }],
    [() => R(200, `<html>${PROVIDER_TEXT}</html>`), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
    [() => R(200, { not_a_token: PROVIDER_TEXT }), { stage: "TOKEN", code: "TOKEN_RESPONSE_INVALID", httpStatus: 200 }],
    [() => { throw Object.assign(new TypeError(`fetch failed ${FAKE_SECRET}`), { cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" } }); },
      { stage: "TOKEN", code: "TOKEN_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }]
  ];
  for (const [tokenReply, diag] of cases) {
    const { r, calls } = await run((u) => (u === TOKEN_URL ? tokenReply() : R(200, { status: "success", result: LISTING_DATA })));
    assert.deepEqual([r.exitCode, r.output.ok, r.output.tokenOk, r.output.listingReadOk, { ...r.output.diag }, r.output.requests],
      [AUTH_EXIT.DIAGNOSED_FAILURE, false, false, false, diag, { token: 1, listing: 0 }], diag.code);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${TOKEN_URL}`]);
    leakFree(r.output);
  }
});

test("read failures after a good token: HTTP status, network, bad envelope, wrong listing — each distinct", async () => {
  const tokenOk = () => R(200, { access_token: FAKE_TOKEN });
  const cases = [
    [() => R(403, PROVIDER_TEXT), { readCode: "READ_HTTP_NOT_OK", readHttpStatus: 403 }],
    [() => R(200, { status: "fail", result: PROVIDER_TEXT }), { readCode: "READ_ENVELOPE_INVALID", readHttpStatus: 200 }],
    [() => R(200, { status: "success", result: { ...LISTING_DATA, id: 603564 } }), { readCode: "READ_LISTING_MISMATCH", readHttpStatus: 200 }]
  ];
  for (const [read, want] of cases) {
    const { r, calls } = await run((u) => (u === TOKEN_URL ? tokenOk() : read()));
    assert.deepEqual([r.exitCode, r.output.tokenOk, r.output.listingReadOk, r.output.readCode, r.output.readHttpStatus, r.output.requests],
      [AUTH_EXIT.DIAGNOSED_FAILURE, true, false, want.readCode, want.readHttpStatus, { token: 1, listing: 1 }], want.readCode);
    assert.equal(calls[1].auth, `Bearer ${FAKE_TOKEN}`);
    leakFree(r.output);
  }
  const { r } = await run((u) => { if (u === TOKEN_URL) return tokenOk(); throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  assert.deepEqual([r.output.tokenOk, r.output.listingReadOk, { ...r.output.diag }], [true, false,
    { stage: "REQUEST", code: "REQUEST_NETWORK_FAILED", errorKind: "FETCH_TYPE_ERROR", causeCode: "ECONNRESET" }]);
});

test("success: exactly one token POST then one GET of listing 606998 (no query, no body); fixed codes only; exit 0", async () => {
  const { r, calls } = await run((u) => (u === TOKEN_URL ? R(200, { access_token: FAKE_TOKEN }) : R(200, { status: "success", result: LISTING_DATA })));
  assert.deepEqual([r.exitCode, r.output.ok, r.output.tokenOk, r.output.listingReadOk, r.output.readCode, r.output.readHttpStatus, r.output.requests],
    [AUTH_EXIT.OK, true, true, true, "READ_OK", 200, { token: 1, listing: 1 }]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url} body:${c.body === undefined ? "none" : "form"}`),
    [`POST ${TOKEN_URL} body:form`, `GET ${LISTING_URL} body:none`]);
  assert.deepEqual(Object.keys(r.output).sort(), ["listingReadOk", "mode", "ok", "readCode", "readHttpStatus", "requests", "reviewedCommit", "tokenOk"].sort());
  leakFree(r.output);
});

// ---------- the local allowlist ----------
test("guardFetch: everything except one token POST and one listing GET is refused BEFORE the real fetch", async () => {
  let inner = 0;
  const g = guardFetch(async () => { inner++; return R(200, {}); });
  const refused = async (url, init) => { try { await g.guarded(url, init); return "SENT"; } catch (e) { return e.name; } };
  for (const [url, init] of [
    ["https://api.hostaway.com/v1/reservations", { method: "POST", body: "{}" }], [`${LISTING_URL}/calendar/priceDetails`, { method: "POST", body: "{}" }],
    ["https://api.hostaway.com/v1/reservations/1/statuses/cancelled", { method: "PUT", body: "{}" }], [LISTING_URL, { method: "DELETE" }],
    [`${LISTING_URL}?includeResources=1`, { method: "GET" }], [LISTING_URL, { method: "GET", body: "x" }], [TOKEN_URL, { method: "GET" }],
    ["https://api.hostaway.com/v1/listings/603564", { method: "GET" }], ["https://evil.example/v1/accessTokens", { method: "POST" }],
    ["https://api.hostaway.com/v1/guestPayments/charges", { method: "GET" }]]) {
    assert.equal(await refused(url, init), "LocalRefusal", `${init.method} ${url}`);
  }
  assert.equal(inner, 0);
  assert.equal(await refused(TOKEN_URL, { method: "POST", body: "x" }), "SENT");
  assert.equal(await refused(TOKEN_URL, { method: "POST", body: "x" }), "LocalRefusal", "second token POST refused (no re-mint)");
  assert.equal(await refused(LISTING_URL, { method: "GET" }), "SENT");
  assert.equal(await refused(LISTING_URL, { method: "GET" }), "LocalRefusal", "second listing GET refused (no retry)");
  assert.deepEqual([inner, g.used()], [2, { token: 1, listing: 1, refused: 12 }]);
});

// ---------- no writes; the spent journal and manifest are untouched ----------
test("no files written anywhere it runs; a spent run folder is byte-identical afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e4-auth-"));
  const run1 = join(dir, "run"); mkdirSync(join(run1, "journal"), { recursive: true });
  writeFileSync(join(run1, "e4-manifest.json"), "{\"spent\":true}\n");
  writeFileSync(join(run1, "journal", "e4-journal-2b7d851c1fbf.jsonl"), "{\"type\":\"run-start\"}\n{\"type\":\"run-end\"}\n");
  const snap = () => readdirSync(dir, { recursive: true }).sort().map((p) => { const f = join(dir, p); return statSync(f).isFile() ? `${p}:${createHash("sha256").update(readFileSync(f)).digest("hex")}` : p; });
  const before = snap();
  const cwd = process.cwd(); process.chdir(dir);
  try { await run((u) => (u === TOKEN_URL ? R(401, {}) : R(200, {}))); await run((u) => (u === TOKEN_URL ? R(200, { access_token: FAKE_TOKEN }) : R(200, { status: "success", result: LISTING_DATA }))); }
  finally { process.chdir(cwd); }
  assert.deepEqual(snap(), before);
  const src = readFileSync(join(ROOT, "scripts/e4-launcher/auth-check.mjs"), "utf8");
  for (const re of [/writeFileSync|appendFileSync|createWriteStream|openSync|mkdirSync|unlink|rmSync|renameSync/, /createFileJournal|readJournalFile|executeHappyRun|runHappyExecute|reconcileHappyFromJournal/,
    /priceDetails|statuses\/cancelled|"\/reservations/, /process\.env/, /console\./]) assert.doesNotMatch(src, re, String(re));
});

test("cli entry: a non-matching reviewed commit is refused at provenance with no prompt and no network", () => {
  const ex = spawnSync(process.execPath, [join(ROOT, "scripts/e4-launcher/auth-check.mjs"), "--reviewed-commit", "0".repeat(40)], { encoding: "utf8", input: "", env: { PATH: process.env.PATH } });
  const out = JSON.parse(ex.stdout);
  assert.deepEqual([ex.status, out.mode, out.stage, out.network, out.credentialsRequested], [AUTH_EXIT.REFUSED, "auth-check", "provenance", "none", false]);
  const usage = spawnSync(process.execPath, [join(ROOT, "scripts/e4-launcher/auth-check.mjs")], { encoding: "utf8", input: "", env: { PATH: process.env.PATH } });
  assert.deepEqual([usage.status, JSON.parse(usage.stdout).error], [AUTH_EXIT.USAGE, "USAGE"]);
});

test("no global fetch was used", () => { assert.equal(globalFetchCalls, 0); });
