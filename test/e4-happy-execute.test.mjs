// E4 happy-path --execute orchestration — offline. Mock git/prompt/fetch; a throwaway LOCAL git repo for the real-git
// provenance check. The global fetch is replaced by a spy that throws: it must never be called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used in tests"); };

const { runHappyExecute, verifyProvenance, parseExecuteArgs, makeGit, EXECUTE_SOURCES, EXIT } = await import("../scripts/e4-launcher/happy-execute.mjs");
const { validateHappyManifest } = await import("../scripts/e4-write-runner/happy-path.mjs");
const { journalFileName } = await import("../scripts/e4-write-runner/journal.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "a".repeat(40);
const NOW = () => new Date("2026-10-22T18:00:00.000Z");
const FAKE_SECRET = "FAKE-client-secret-not-real-123";
const FAKE_TOKEN = "FAKE-access-token-not-real-456";
const MANIFEST = { manifestVersion: "e4-happy-manifest-v1", listingId: 606998, refFieldId: 105433, currency: "USD", nightlyMinor: 10000, cleaningFeeMinor: 5000,
  guests: 2, window: { start: "2027-03-08", end: "2027-03-15" }, stay: { arrivalDate: "2027-03-10", departureDate: "2027-03-12" },
  guest: { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" } };
const TOKEN = validateHappyManifest(MANIFEST, { now: NOW }).confirmToken;

// ---- fakes ----
function fakeGit({ head = SHA, dirty = "", tree = null, hashes = null, fail = null } = {}) {
  const real = spawnSync("git", ["hash-object", "--", ...EXECUTE_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
  const calls = [];
  const git = (args) => {
    calls.push(args[0]);
    if (fail === args[0]) return { status: 128, stdout: "" };
    if (args[0] === "rev-parse") return { status: 0, stdout: `${head}\n` };
    if (args[0] === "status") return { status: 0, stdout: dirty };
    if (args[0] === "ls-tree") return { status: 0, stdout: (tree ?? EXECUTE_SOURCES.map((p, i) => `100644 blob ${real[i]}\t${p}`)).join("\n") + "\n" };
    if (args[0] === "hash-object") return { status: 0, stdout: (hashes ?? real).join("\n") + "\n" };
    return { status: 1, stdout: "" };
  };
  return { git, calls, real };
}
function setup({ manifest = MANIFEST } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "e4-exec-"));
  const m = join(dir, "manifest.json");
  writeFileSync(m, JSON.stringify(manifest));
  const jdir = join(dir, "journal");
  mkdirSync(jdir);
  return { dir, m, jdir };
}
const args = (s, over = {}) => [s.m, s.jdir, "--confirm", over.confirm ?? TOKEN, "--reviewed-commit", over.sha ?? SHA];
const json = (status, body) => new Response(body === undefined ? "" : JSON.stringify(body), { status });
function fakeProvider({ conversations = 0 } = {}) {
  const reservations = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const c = { method: init.method, path: u.pathname.replace(/^\/v1/, ""), query: Object.fromEntries(u.searchParams), headers: init.headers || {}, body: init.body };
    calls.push(c);
    if (c.method === "POST" && c.path === "/accessTokens") return json(200, { token_type: "Bearer", expires_in: 3600, access_token: FAKE_TOKEN });
    if (c.headers.Authorization !== `Bearer ${FAKE_TOKEN}`) return json(401, { status: "fail" });
    let r; let mm;
    if (c.method === "POST" && /priceDetails$/.test(c.path)) return json(200, { status: "success", result: { totalPrice: 250 } });
    if (c.method === "POST" && c.path === "/reservations") {
      const b = JSON.parse(c.body);
      r = { id: 9100001, listingMapId: b.listingMapId, channelId: b.channelId, arrivalDate: b.arrivalDate, departureDate: b.departureDate, totalPrice: b.totalPrice,
        currency: b.currency, status: "new", guestName: b.guestName, guestEmail: b.guestEmail, customFieldValues: b.customFieldValues };
      reservations.push(r);
      return json(200, { status: "success", result: r });
    }
    if (c.method === "GET" && c.path === "/reservations") return json(200, { status: "success", result: c.query.afterId ? [] : reservations.filter((x) => x.arrivalDate === c.query.arrivalStartDate) });
    if (c.method === "GET" && (mm = /^\/reservations\/(\d+)$/.exec(c.path))) { r = reservations.find((x) => x.id === Number(mm[1])); return json(200, { status: "success", result: r }); }
    if (c.method === "PUT" && (mm = /^\/reservations\/(\d+)\/statuses\/cancelled$/.exec(c.path))) { r = reservations.find((x) => x.id === Number(mm[1])); r.status = "cancelled"; return json(200, { status: "success", result: r }); }
    const rid = Number(c.query.reservationId);
    if (c.path === "/guestPayments/charges") return json(200, { status: "success", result: [], count: 0, offset: null });
    if (c.path === "/conversations") return json(200, { status: "success", result: Array.from({ length: conversations }, () => ({ reservationId: String(rid) })) });
    if (c.path === "/tasks") return json(200, { status: "success", result: [] });
    return json(404, { status: "fail" });
  };
  return { fetchImpl, calls, reservations };
}
function promptSpy(result = { accountId: "12345", clientSecret: FAKE_SECRET }) {
  const s = { calls: 0 };
  s.prompt = async () => { s.calls++; if (result instanceof Error) throw result; return Object.freeze({ ...result }); };
  return s;
}

// ---------- refusals before any prompt or network ----------
test("arguments: strict; anything malformed is refused with zero prompts and zero fetches", async () => {
  const s = setup(); const p = promptSpy(); const f = fakeProvider(); const g = fakeGit();
  for (const [argv, code] of [[[], "USAGE"], [[s.m, s.jdir], "USAGE"], [[s.m, s.jdir, "--confirm", TOKEN], "USAGE"],
    [[s.m, s.jdir, "--confirm", TOKEN, "--reviewed-commit", "abc"], "REVIEWED_COMMIT_INVALID"], [[s.m, s.jdir, "--confirm", "x", "--reviewed-commit", SHA], "CONFIRM_TOKEN_INVALID"],
    [[s.m, s.jdir, "--confirm", TOKEN, "--confirm", TOKEN], "USAGE"], [[s.m, s.jdir, "--secret", "x", "--reviewed-commit", SHA], "USAGE"],
    [["--confirm", TOKEN, "--reviewed-commit", SHA, s.m, s.jdir], "USAGE"], [[s.m, s.jdir, "--confirm", TOKEN, "--reviewed-commit", SHA.toUpperCase()], "REVIEWED_COMMIT_INVALID"]]) {
    const r = await runHappyExecute(argv, { git: g.git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
    assert.equal(r.output.error, code, JSON.stringify(argv));
    assert.ok(r.exitCode === EXIT.USAGE || r.exitCode === EXIT.REFUSED);
  }
  assert.deepEqual([p.calls, f.calls.length, g.calls.length], [0, 0, 0]);
  assert.deepEqual(parseExecuteArgs([s.m, s.jdir, "--reviewed-commit", SHA, "--confirm", TOKEN]).ok, true, "flag order free");
});

test("provenance: wrong HEAD, dirty or untracked source, blob mismatch, missing in commit, git unavailable => refused before prompt/network", async () => {
  const base = fakeGit();
  const cases = [
    [{ head: "b".repeat(40) }, "HEAD_NOT_REVIEWED_COMMIT"],
    [{ dirty: " M scripts/e4-write-runner/happy-path.mjs\n" }, "SOURCE_DIRTY"],
    [{ dirty: "?? scripts/e4-transport/credential-prompt.mjs\n" }, "SOURCE_DIRTY"],
    [{ hashes: base.real.map((h, i) => (i === 3 ? "0".repeat(40) : h)) }, `SOURCE_MISMATCH:${EXECUTE_SOURCES[3]}`],
    [{ tree: EXECUTE_SOURCES.slice(1).map((p, i) => `100644 blob ${base.real[i + 1]}\t${p}`) }, `SOURCE_NOT_IN_REVIEWED_COMMIT:${EXECUTE_SOURCES[0]}`],
    [{ hashes: base.real.slice(1) }, "SOURCE_MISSING"],
    [{ fail: "rev-parse" }, "GIT_UNAVAILABLE"], [{ fail: "ls-tree" }, "GIT_UNAVAILABLE"]
  ];
  for (const [opt, code] of cases) {
    const s = setup(); const p = promptSpy(); const f = fakeProvider();
    const r = await runHappyExecute(args(s), { git: fakeGit(opt).git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
    assert.deepEqual([r.exitCode, r.output.stage, r.output.error, r.output.credentialsRequested], [EXIT.REFUSED, "provenance", code, false], code);
    assert.deepEqual([p.calls, f.calls.length, readdirSync(s.jdir).length], [0, 0, 0], code);
  }
  assert.ok(EXECUTE_SOURCES.includes("scripts/e4-launcher/happy-execute.mjs") && EXECUTE_SOURCES.includes("scripts/e4-write-runner/happy-cli.mjs"));
});

test("preflight/confirm: owner input missing, journal already exists, wrong confirm token => refused before prompt/network", async () => {
  const p = promptSpy(); const f = fakeProvider(); const g = fakeGit();
  let s = setup({ manifest: { ...MANIFEST, guest: "<OWNER_INPUT>" } });
  let r = await runHappyExecute(args(s), { git: g.git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
  assert.deepEqual([r.output.stage, r.output.error], ["preflight", "PREFLIGHT_FAILED:OWNER_INPUT_REQUIRED:guest"]);
  s = setup();
  writeFileSync(join(s.jdir, journalFileName(validateHappyManifest(MANIFEST, { now: NOW }).hash)), "");
  r = await runHappyExecute(args(s), { git: g.git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
  assert.equal(r.output.error, "PREFLIGHT_FAILED:JOURNAL_EXISTS");
  s = setup();
  r = await runHappyExecute(args(s, { confirm: "E4-HAPPY-000000000000" }), { git: g.git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
  assert.deepEqual([r.output.stage, r.output.error], ["preflight", "CONFIRM_TOKEN_MISMATCH"]);
  assert.deepEqual([p.calls, f.calls.length], [0, 0]);
});

test("credentials: an aborted prompt exits before any journal or network", async () => {
  const s = setup(); const f = fakeProvider();
  const err = Object.assign(new Error("x"), { code: "ABORTED" });
  const p = promptSpy(err);
  const r = await runHappyExecute(args(s), { git: fakeGit().git, prompt: p.prompt, fetchImpl: f.fetchImpl, now: NOW });
  assert.deepEqual([r.exitCode, r.output.stage, r.output.error, r.output.network], [EXIT.REFUSED, "credentials", "ABORTED", "none"]);
  assert.deepEqual([p.calls, f.calls.length, readdirSync(s.jdir).length], [1, 0, 0]);
});

// ---------- the run (mock provider) ----------
test("execute (mock): prompt once AFTER all checks; 1 mint; 1 create + 1 cancel; journal written and closed; sanitized output; exit 0", async () => {
  const s = setup(); const f = fakeProvider(); const p = promptSpy();
  const order = [];
  const git = fakeGit();
  const r = await runHappyExecute(args(s), { git: (a) => { order.push(`git:${a[0]}`); return git.git(a); },
    prompt: async () => { order.push("prompt"); return p.prompt(); }, fetchImpl: async (u, i) => { order.push("fetch"); return f.fetchImpl(u, i); }, now: NOW });
  assert.equal(r.exitCode, EXIT.COMPLETED, JSON.stringify(r.output.halt));
  assert.deepEqual(order.slice(0, 6), ["git:rev-parse", "git:status", "git:ls-tree", "git:hash-object", "prompt", "fetch"]);
  assert.equal(f.calls.filter((c) => c.path === "/accessTokens").length, 1);
  assert.deepEqual(f.calls.filter((c) => c.method === "PUT" || (c.method === "POST" && c.path === "/reservations")).map((c) => `${c.method} ${c.path}`),
    ["POST /reservations", "PUT /reservations/9100001/statuses/cancelled"]);
  assert.equal(p.calls, 1);
  const files = readdirSync(s.jdir);
  assert.deepEqual(files, [r.output.journalFile]);
  const journalText = readFileSync(join(s.jdir, files[0]), "utf8");
  const outText = JSON.stringify(r.output);
  for (const x of [FAKE_SECRET, FAKE_TOKEN, "12345", "Synthetic", "Tester", "e4-synthetic@", "guestName", "guestEmail"]) {
    assert.ok(!outText.includes(x), `output leaks ${x}`);
    assert.ok(!journalText.includes(x), `journal leaks ${x}`);
  }
  assert.deepEqual([r.output.status, r.output.writes, r.output.reviewedCommit, r.output.sideEffectReads], ["COMPLETED", { create: 1, cancel: 1 }, SHA, 6]);
});

test("execute (mock): a conversation on the new reservation halts after the create; no cancel; exit 3", async () => {
  const s = setup(); const f = fakeProvider({ conversations: 1 });
  const r = await runHappyExecute(args(s), { git: fakeGit().git, prompt: promptSpy().prompt, fetchImpl: f.fetchImpl, now: NOW });
  assert.deepEqual([r.exitCode, r.output.status, r.output.halt.step, r.output.halt.code], [EXIT.HALTED, "HALTED", "HW1_CREATE", "SIDE_EFFECT_SIGNAL"]);
  assert.ok(!f.calls.some((c) => c.method === "PUT"));
});

test("execute: the journal is closed in finally even if the runner throws; internal error is a code only", async () => {
  const s = setup(); let closed = 0;
  const r = await runHappyExecute(args(s), { git: fakeGit().git, prompt: promptSpy().prompt, fetchImpl: fakeProvider().fetchImpl, now: NOW,
    createJournal: () => ({ durable: true, load: () => [], append() {}, close: () => { closed++; } }),
    execute: async () => { throw new Error(`boom ${FAKE_SECRET}`); } });
  assert.deepEqual([r.exitCode, r.output.error, closed], [EXIT.INTERNAL, "INTERNAL_ERROR", 1]);
  assert.ok(!JSON.stringify(r.output).includes(FAKE_SECRET));
});

// ---------- real git (throwaway local repo; no network) ----------
test("provenance with real git: exact commit + clean sources pass; edits, untracked sources and other commits fail", () => {
  const repo = mkdtempSync(join(tmpdir(), "e4-git-"));
  const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  assert.equal(g("init", "-q").status, 0);
  for (const p of EXECUTE_SOURCES) { mkdirSync(join(repo, dirname(p)), { recursive: true }); copyFileSync(join(ROOT, p), join(repo, p)); }
  g("add", "-A"); g("commit", "-q", "-m", "c1");
  const c1 = g("rev-parse", "HEAD").stdout.trim();
  const git = makeGit(repo);
  assert.deepEqual(verifyProvenance({ reviewedCommit: c1, git }), { ok: true });
  writeFileSync(join(repo, EXECUTE_SOURCES[2]), "// edited\n", { flag: "a" });
  assert.equal(verifyProvenance({ reviewedCommit: c1, git }).code, "SOURCE_DIRTY");
  g("commit", "-q", "-am", "c2");
  const c2 = g("rev-parse", "HEAD").stdout.trim();
  assert.equal(verifyProvenance({ reviewedCommit: c1, git }).code, "HEAD_NOT_REVIEWED_COMMIT", "HEAD moved past the reviewed commit");
  assert.deepEqual(verifyProvenance({ reviewedCommit: c2, git }), { ok: true });
  assert.equal(verifyProvenance({ reviewedCommit: c2, git: makeGit(mkdtempSync(join(tmpdir(), "e4-nogit-"))) }).code, "GIT_UNAVAILABLE");
});

test("cli: --execute with a non-matching reviewed commit is refused at provenance; no prompt, no network", () => {
  const s = setup();
  const cli = join(ROOT, "scripts/e4-write-runner/happy-cli.mjs");
  const ex = spawnSync(process.execPath, [cli, "--execute", ...args(s, { sha: "0".repeat(40) })], { encoding: "utf8", input: "", env: { PATH: process.env.PATH } });
  const out = JSON.parse(ex.stdout);
  assert.deepEqual([ex.status, out.stage, out.credentialsRequested, out.network], [EXIT.REFUSED, "provenance", false, "none"]);
  assert.ok(["HEAD_NOT_REVIEWED_COMMIT", "GIT_UNAVAILABLE"].includes(out.error));
  assert.equal(readdirSync(s.jdir).length, 0);
});

test("containment: launcher reads no env, logs nothing, writes no files itself; fetch only injected/at call time; global fetch never called", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-launcher/happy-execute.mjs"), "utf8");
  for (const re of [/process\.env/, /console\./, /writeFileSync|appendFileSync|createWriteStream/, /(^|[^.\w])fetch\s*\(/m, /https?:\/\//, /\beval\s*\(|new Function/]) assert.doesNotMatch(src, re, String(re));
  assert.match(src, /deps\.fetchImpl \?\? globalThis\.fetch/);
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name) && /happy-execute/.test(readFileSync(join(ROOT, p), "utf8"))) out.push(p);
    }
    return out;
  };
  assert.deepEqual([...walk("api"), ...walk("lib"), ...walk("db")], []);
  assert.equal(globalFetchCalls, 0);
});
