// E4 happy-path launcher pieces — preflight (read-only, no files written) and hidden credential prompt (fake TTY).
// Offline: no network, no real terminal, no credentials. Typed values below are FAKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { happyPreflight, gitBlobHash, PREFLIGHT_SOURCES } from "../scripts/e4-write-runner/happy-preflight.mjs";
import { readHiddenLine, promptHostawayCredentials } from "../scripts/e4-transport/credential-prompt.mjs";
import { validateHappyManifest } from "../scripts/e4-write-runner/happy-path.mjs";
import { journalFileName } from "../scripts/e4-write-runner/journal.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const NOW = () => new Date("2026-10-22T18:00:00.000Z");
const PROPOSAL = readFileSync(join(ROOT, "scripts/e4-write-runner/happy-manifest.proposal-2027-03.json"), "utf8");
const COMPLETE = JSON.stringify({ ...JSON.parse(PROPOSAL), guest: { firstName: "Synthetic", lastName: "Tester", email: "e4-synthetic@example.invalid" } });

// ---------- preflight ----------
test("proposal manifest: Mar 10-12 2027 inside the window, but NOT approvable until the owner supplies the guest", () => {
  const r = happyPreflight({ manifestText: PROPOSAL, journalDir: mkdtempSync(join(tmpdir(), "e4-pf-")), now: NOW });
  assert.equal(r.checksPassed, false);
  assert.deepEqual(r.manifest.blockers, ["OWNER_INPUT_REQUIRED:guest"]);
  assert.ok(r.blockers.includes("OWNER_INPUT_REQUIRED:guest"));
  assert.deepEqual([r.network, r.credentialsRequested, r.filesWritten, r.preflightExecutes], ["none", false, 0, false]);
  const p = JSON.parse(PROPOSAL);
  assert.deepEqual([p.window, p.stay], [{ start: "2027-03-08", end: "2027-03-15" }, { arrivalDate: "2027-03-10", departureDate: "2027-03-12" }]);
});

test("complete manifest: hash/token/journal name; journal must not exist; dir must be writable; nothing is written", () => {
  const dir = mkdtempSync(join(tmpdir(), "e4-pf-"));
  const r = happyPreflight({ manifestText: COMPLETE, journalDir: dir, now: NOW });
  const v = validateHappyManifest(JSON.parse(COMPLETE), { now: NOW });
  assert.equal(r.checksPassed, true, JSON.stringify(r.blockers));
  assert.deepEqual([r.manifest.hash, r.manifest.confirmToken, r.manifest.totalMinor, r.manifest.currency], [v.hash, v.confirmToken, 25000, "USD"]);
  assert.deepEqual([r.journal.file, r.journal.exists, r.journal.dirWritable], [journalFileName(v.hash), false, true]);
  assert.deepEqual(readdirSync(dir), [], "preflight created nothing");
  assert.equal(r.preflightExecutes, false, "a passing preflight executes nothing");
  writeFileSync(join(dir, journalFileName(v.hash)), "");
  const again = happyPreflight({ manifestText: COMPLETE, journalDir: dir, now: NOW });
  assert.deepEqual([r.journal.ok, again.checksPassed, again.journal.exists, again.journal.ok], [true, false, true, false]);
  assert.ok(again.blockers.includes("JOURNAL_EXISTS"));
  const missing = happyPreflight({ manifestText: COMPLETE, journalDir: join(dir, "nope"), now: NOW });
  assert.ok(missing.blockers.includes("JOURNAL_DIR_NOT_WRITABLE"));
  assert.ok(happyPreflight({ manifestText: "{", journalDir: dir, now: NOW }).blockers.includes("MANIFEST_INVALID"));
  assert.ok(!JSON.stringify(r).includes("Synthetic") && !JSON.stringify(r).includes("e4-synthetic@"), "no guest data in output");
});

test("provenance: git blob ids of every source a run would load (match git hash-object when git is available)", () => {
  const r = happyPreflight({ manifestText: COMPLETE, journalDir: tmpdir(), now: NOW });
  assert.deepEqual(r.sources.map((s) => s.path), [...PREFLIGHT_SOURCES]);
  for (const s of r.sources) assert.match(s.gitBlob, /^[0-9a-f]{40}$/);
  assert.equal(gitBlobHash(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  const g = spawnSync("git", ["hash-object", ...PREFLIGHT_SOURCES], { cwd: ROOT, encoding: "utf8" });
  if (g.status === 0) assert.deepEqual(g.stdout.trim().split("\n"), r.sources.map((s) => s.gitBlob));
});

test("cli: --preflight is read-only and needs no credentials; a malformed --execute is refused before anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "e4-pf-"));
  const m = join(dir, "m.json");
  writeFileSync(m, PROPOSAL);
  const cli = join(ROOT, "scripts/e4-write-runner/happy-cli.mjs");
  const pf = spawnSync(process.execPath, [cli, "--preflight", m, dir], { encoding: "utf8", env: {}, input: "" });
  assert.equal(pf.status, 1);
  const out = JSON.parse(pf.stdout);
  assert.deepEqual([out.mode, out.network, out.credentialsRequested, out.preflightExecutes], ["preflight", "none", false, false]);
  assert.deepEqual(readdirSync(dir), ["m.json"]);
  const ex = spawnSync(process.execPath, [cli, "--execute", m], { encoding: "utf8", env: {}, input: "" });
  assert.deepEqual([ex.status, JSON.parse(ex.stdout).error, JSON.parse(ex.stdout).credentialsRequested], [64, "USAGE", false]);
  const src = readFileSync(cli, "utf8");
  assert.doesNotMatch(src, /hostaway-transport|side-effects|credential-prompt|executeHappyRun|process\.env/);
  const pfsrc = readFileSync(join(ROOT, "scripts/e4-write-runner/happy-preflight.mjs"), "utf8");
  assert.doesNotMatch(pfsrc, /^import[^\n]*(hostaway-transport|side-effects|credential-prompt)/m, "preflight only hashes those files");
  assert.doesNotMatch(pfsrc, /writeFileSync|openSync|mkdirSync|createFileJournal|process\.env|fetch\s*\(/);
});

// ---------- hidden credential prompt (fake TTY) ----------
function fakeTty({ isTTY = true } = {}) {
  const input = new EventEmitter();
  input.isTTY = isTTY;
  input.rawModes = [];
  input.setRawMode = (on) => { input.rawModes.push(on); };
  input.resume = () => {};
  input.pause = () => {};
  const written = [];
  const output = { write: (s) => { written.push(String(s)); } };
  const type = (s) => setImmediate(() => input.emit("data", Buffer.from(s)));
  return { input, output, written, type };
}

test("prompt: echo off; Enter finishes; Backspace edits; raw mode restored; typed text never written", async () => {
  const t = fakeTty();
  const p = readHiddenLine({ input: t.input, output: t.output, label: "Secret" });
  t.type("FAKE-secX\u007fret-123\r");
  assert.equal(await p, "FAKE-secret-123");
  assert.deepEqual(t.input.rawModes, [true, false]);
  assert.equal(t.input.listenerCount("data"), 0);
  assert.ok(!t.written.join("").includes("FAKE"));
});

test("prompt: refuses non-TTY input (no pipes/files); Ctrl-C/Ctrl-D abort; over-long input fails — codes only", async () => {
  for (const input of [fakeTty({ isTTY: false }).input, { isTTY: true }, null]) {
    await assert.rejects(readHiddenLine({ input, output: { write() {} }, label: "x" }), (e) => e.code === "TTY_REQUIRED");
  }
  for (const key of ["\u0003", "\u0004"]) {
    const t = fakeTty();
    const p = readHiddenLine({ input: t.input, output: t.output, label: "x" });
    t.type(`FAKE${key}`);
    await assert.rejects(p, (e) => e.code === "ABORTED" && !String(e.message).includes("FAKE"));
    assert.deepEqual(t.input.rawModes, [true, false]);
  }
  const t = fakeTty();
  const p = readHiddenLine({ input: t.input, output: t.output, label: "x" });
  t.type("a".repeat(600));
  await assert.rejects(p, (e) => e.code === "INPUT_TOO_LONG");
});

test("credentials: account id then secret, both hidden; invalid values rejected without revealing them", async () => {
  let t = fakeTty();
  let p = promptHostawayCredentials({ input: t.input, output: t.output });
  t.type("12345\r");
  setTimeout(() => t.input.emit("data", Buffer.from("FAKE-not-a-real-secret\r")), 20);
  assert.deepEqual({ ...(await p) }, { accountId: "12345", clientSecret: "FAKE-not-a-real-secret" });
  assert.ok(!t.written.join("").includes("12345") && !t.written.join("").includes("FAKE"));
  t = fakeTty();
  p = promptHostawayCredentials({ input: t.input, output: t.output });
  t.type("12a45\r");
  await assert.rejects(p, (e) => e.code === "ACCOUNT_ID_INVALID" && !e.message.includes("12a45"));
  t = fakeTty();
  p = promptHostawayCredentials({ input: t.input, output: t.output });
  t.type("12345\r");
  setTimeout(() => t.input.emit("data", Buffer.from("FAKE secret\r")), 20);
  await assert.rejects(p, (e) => e.code === "SECRET_INVALID" && !e.message.includes("FAKE"));
});

test("containment: prompt has no imports, no env, no files, no logging, no network; nothing deployable imports the launcher pieces", () => {
  const src = readFileSync(join(ROOT, "scripts/e4-transport/credential-prompt.mjs"), "utf8");
  assert.doesNotMatch(src, /^import /m);
  for (const re of [/process\.env/, /readFileSync|writeFileSync|appendFile|createWriteStream/, /console\./, /fetch\s*\(/, /process\.argv/]) assert.doesNotMatch(src, re, String(re));
  const walk = (d, out = []) => {
    for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p, out); else if (/\.(m?js|cjs)$/.test(e.name) && /credential-prompt|happy-preflight/.test(readFileSync(join(ROOT, p), "utf8"))) out.push(p);
    }
    return out;
  };
  assert.deepEqual([...walk("api"), ...walk("lib"), ...walk("db")], []);
});
