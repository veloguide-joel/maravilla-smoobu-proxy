// E4 explicit retry attempt + prior-journal clearance — offline. Real files in temp dirs and the real journal/runner/launcher
// code; mock git/prompt/fetch only; FAKE secrets. The global fetch is a throwing spy that must never be called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let globalFetchCalls = 0;
globalThis.fetch = () => { globalFetchCalls++; throw new Error("global fetch must not be used"); };

const { validateHappyManifest, checkPriorJournalClear, planHappyRun, MAX_ATTEMPT } = await import("../scripts/e4-write-runner/happy-path.mjs");
const { happyPreflight } = await import("../scripts/e4-write-runner/happy-preflight.mjs");
const { journalFileName } = await import("../scripts/e4-write-runner/journal.mjs");
const { runHappyExecute, EXECUTE_SOURCES, EXIT } = await import("../scripts/e4-launcher/happy-execute.mjs");

const ROOT = new URL("..", import.meta.url).pathname;
const SHA = "a".repeat(40);
const NOW = () => new Date("2026-10-23T15:00:00.000Z");
// The owner's approved manifest (2026-10-22 approval record), byte-for-byte as the setup script wrote it.
const ORIGINAL_TEXT = `{
  "manifestVersion": "e4-happy-manifest-v1",
  "listingId": 606998,
  "refFieldId": 105433,
  "currency": "USD",
  "nightlyMinor": 10000,
  "cleaningFeeMinor": 5000,
  "guests": 2,
  "window": { "start": "2027-03-08", "end": "2027-03-15" },
  "stay": { "arrivalDate": "2027-03-10", "departureDate": "2027-03-12" },
  "guest": { "firstName": "Joel", "lastName": "Test", "email": "Joel@veloguide.com" }
}
`;
const ORIGINAL = JSON.parse(ORIGINAL_TEXT);
const ORIGINAL_HASH = "2b7d851c1fbfe8166b481b60598804bfabbd73299c4ffe1a50e666bf01b8f48c";
const ATTEMPT2 = { ...ORIGINAL, attempt: 2 };
const A2 = validateHappyManifest(ATTEMPT2, { now: NOW });
const A3 = validateHappyManifest({ ...ORIGINAL, attempt: 3 }, { now: NOW });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// The spent journal exactly as the reviewed 7192c23 runner wrote it (no diag field existed then): token failure at P0.
const at = (s) => `2026-10-22T13:57:${s}Z`;
const SPENT = [
  { type: "run-start", runId: "0123456789abcdef", manifestHash: ORIGINAL_HASH, refs: ["MV-AAAAAAAAAAAA", "MV-BBBBBBBBBBBB"], at: at("26.550") },
  { type: "read", step: "P0_PREFLIGHT_PRICE", kind: "calc", code: "PRICE_TRANSPORT_UNCERTAIN", at: at("26.995") },
  { type: "halt", step: "P0_PREFLIGHT_PRICE", code: "PRICE_TRANSPORT_UNCERTAIN", at: at("27.000") },
  { type: "run-end", code: "HALTED", at: at("27.001") }
];
const jsonl = (es) => es.map((e) => `${JSON.stringify(e)}\n`).join("");
function runFolder(journalText = jsonl(SPENT), hash = ORIGINAL_HASH) {
  const dir = mkdtempSync(join(tmpdir(), "e4-retry-"));
  const jdir = join(dir, "journal"); mkdirSync(jdir);
  writeFileSync(join(dir, "e4-manifest.json"), ORIGINAL_TEXT);
  if (journalText !== null) writeFileSync(join(jdir, journalFileName(hash)), journalText);
  return { dir, jdir };
}
const snapshot = (dir) => readdirSync(dir, { recursive: true }).sort().map((p) => { try { return `${p}:${sha256(readFileSync(join(dir, p)))}`; } catch { return `${p}/`; } });
const pre = (manifest, jdir) => happyPreflight({ manifestText: JSON.stringify(manifest), journalDir: jdir, now: NOW, root: ROOT });

// ---------- schema ----------
test("attempt field: absent keeps the original hash/token; explicit 2 is a distinct, derivable retry; invalid values refused", () => {
  const v1 = validateHappyManifest(ORIGINAL, { now: NOW });
  assert.deepEqual([v1.ok, v1.hash, v1.confirmToken, v1.attempt, v1.priorHashes], [true, ORIGINAL_HASH, "E4-HAPPY-2b7d851c1fbf", 1, []]);
  assert.deepEqual([A2.ok, A2.attempt, A2.priorHashes], [true, 2, [ORIGINAL_HASH]]);
  assert.notEqual(A2.hash, ORIGINAL_HASH);
  assert.equal(A2.confirmToken, `E4-HAPPY-${A2.hash.slice(0, 12)}`);
  assert.deepEqual(A3.priorHashes, [ORIGINAL_HASH, A2.hash]);
  const { attempt: _x, ...business } = A2.manifest;
  assert.deepEqual(business, ORIGINAL, "every business value unchanged");
  for (const bad of [1, 0, -2, MAX_ATTEMPT + 1, "2", 2.5, null, true, [2]]) {
    const r = validateHappyManifest({ ...ORIGINAL, attempt: bad }, { now: NOW });
    assert.deepEqual([r.ok, r.errors], [false, ["ATTEMPT_INVALID"]], JSON.stringify(bad));
  }
  assert.deepEqual(validateHappyManifest({ ...ORIGINAL, retry: 2 }, { now: NOW }).errors, ["UNKNOWN_FIELD:retry"]);
  // A changed business value derives a different prior hash, so the original journal can never vouch for it.
  const moved = validateHappyManifest({ ...ATTEMPT2, window: { start: "2027-03-09", end: "2027-03-15" } }, { now: NOW });
  assert.notEqual(moved.priorHashes[0], ORIGINAL_HASH);
  const plan = planHappyRun(ATTEMPT2, { now: NOW });
  assert.deepEqual([plan.attempt, plan.priorManifestHashes, plan.network], [2, [ORIGINAL_HASH], "none"]);
});

// ---------- clearance rules ----------
test("checkPriorJournalClear: only a run of that exact manifest that halted before any write is clear", () => {
  assert.deepEqual(checkPriorJournalClear(SPENT, ORIGINAL_HASH), { ok: true, code: "CLEAR_HALTED_BEFORE_WRITE", haltStep: "P0_PREFLIGHT_PRICE", haltCode: "PRICE_TRANSPORT_UNCERTAIN" });
  const withDiag = SPENT.map((e) => (e.type === "halt" || e.type === "read" ? { ...e, diag: { stage: "TOKEN", code: "TOKEN_HTTP_REFUSED", httpStatus: 401 } } : e));
  assert.equal(checkPriorJournalClear(withDiag, ORIGINAL_HASH).ok, true);
  const p1 = [SPENT[0], { type: "read", step: "P0_PREFLIGHT_PRICE", kind: "calc", code: "PRICE_OK", observedTotalMinor: 25000, httpStatus: 200, at: at("27.1") },
    { type: "read", step: "P1_PREFLIGHT_CLEAR", kind: "lookup", code: "NOT_FOUND", ref: "MV-AAAAAAAAAAAA", itemsSeen: 1, at: at("27.2") },
    { type: "halt", step: "P1_PREFLIGHT_CLEAR", code: "PREFLIGHT_NOT_CLEAR", itemsSeen: 1, at: at("27.3") }, { type: "run-end", code: "HALTED", at: at("27.4") }];
  assert.equal(checkPriorJournalClear(p1, ORIGINAL_HASH).ok, true);
  const ins = (i, e) => [...SPENT.slice(0, i), e, ...SPENT.slice(i)];
  const bad = {
    MANIFEST_MISMATCH: [SPENT, "f".repeat(64)],
    NOT_RUN_START: [[SPENT[1], ...SPENT], ORIGINAL_HASH],
    NOT_TERMINAL_HALTED: [SPENT.slice(0, 3), ORIGINAL_HASH],
    NOT_TERMINAL_HALTED_COMPLETED: [[...SPENT.slice(0, 3), { type: "run-end", code: "COMPLETED", at: at("27.1") }], ORIGINAL_HASH],
    UNRECOGNIZED_ENTRY_INTENT: [ins(2, { type: "intent", step: "HW1_CREATE", kind: "create", ref: "MV-BBBBBBBBBBBB", at: at("26.996") }), ORIGINAL_HASH],
    UNRECOGNIZED_ENTRY_OUTCOME: [ins(2, { type: "outcome", step: "HW1_CREATE", kind: "create", code: "CREATED", at: at("26.996") }), ORIGINAL_HASH],
    UNRECOGNIZED_ENTRY_SIDE: [ins(2, { type: "side-effect-check", step: "HW1_CREATE", code: "NO_SIGNAL_REPORTED", at: at("26.996") }), ORIGINAL_HASH],
    UNRECOGNIZED_ENTRY_RECON: [ins(3, { type: "reconcile", step: "HR_RECONCILE", code: "X", at: at("27.0005") }), ORIGINAL_HASH],
    HALT_NOT_PRE_WRITE: [SPENT.map((e) => (e.type === "halt" ? { ...e, step: "HW1_CREATE" } : e)), ORIGINAL_HASH],
    NOT_PRE_WRITE_ONLY_READ_HW: [ins(2, { type: "read", step: "P2_READBACK", kind: "read", code: "READ_OK", at: at("26.996") }), ORIGINAL_HASH],
    NOT_PRE_WRITE_ONLY_TWO_RUNS: [[SPENT[0], ...SPENT], ORIGINAL_HASH],
    NOT_PRE_WRITE_ONLY_TWO_HALTS: [ins(2, SPENT[2]), ORIGINAL_HASH],
    UNRECOGNIZED_FIELD: [SPENT.map((e, i) => (i === 1 ? { ...e, reservationId: 123 } : e)), ORIGINAL_HASH],
    UNRECOGNIZED_FIELD_AT: [SPENT.map((e, i) => (i === 3 ? { ...e, at: "yesterday" } : e)), ORIGINAL_HASH],
    SHAPE: [[], ORIGINAL_HASH],
    TRAILING: [[...SPENT, SPENT[1]], ORIGINAL_HASH]
  };
  for (const [name, [es, h]] of Object.entries(bad)) {
    const r = checkPriorJournalClear(es, h);
    assert.equal(r.ok, false, name);
    assert.match(r.code, /^NOT_CLEAR_[A-Z_]+$/, name);
  }
  assert.equal(checkPriorJournalClear(null, ORIGINAL_HASH).ok, false);
});

// ---------- preflight on real files ----------
test("preflight: attempt 2 passes only with the exact spent journal clear in the SAME directory; prior bytes never change", () => {
  const ok = runFolder();
  const before = snapshot(ok.dir);
  const r = pre(ATTEMPT2, ok.jdir);
  assert.deepEqual([r.checksPassed, r.blockers, r.manifest.attempt, r.manifest.confirmToken, r.journal.file, r.journal.exists],
    [true, [], 2, A2.confirmToken, journalFileName(A2.hash), false]);
  assert.deepEqual(r.journal.prior, [{ attempt: 1, file: "e4-journal-2b7d851c1fbf.jsonl", code: "CLEAR_HALTED_BEFORE_WRITE" }]);
  // The original manifest is still refused in this folder (replay protection unchanged).
  assert.ok(pre(ORIGINAL, ok.jdir).blockers.includes("JOURNAL_EXISTS"));
  const cases = [
    ["missing (alternate/empty journal dir)", runFolder(null), "PRIOR_JOURNAL_MISSING:attempt1"],
    ["torn last line", runFolder(jsonl(SPENT).slice(0, -1)), "PRIOR_JOURNAL_CORRUPT:attempt1"],
    ["malformed line", runFolder(`${jsonl(SPENT)}{not json\n`), "PRIOR_JOURNAL_CORRUPT:attempt1"],
    ["empty file", runFolder(""), "PRIOR_JOURNAL_NOT_CLEAR_SHAPE:attempt1"],
    ["prior write intent", runFolder(jsonl([...SPENT.slice(0, 2), { type: "intent", step: "HW1_CREATE", kind: "create", at: at("26.996") }, ...SPENT.slice(2)])), "PRIOR_JOURNAL_NOT_CLEAR_UNRECOGNIZED_ENTRY:attempt1"],
    ["no run-end", runFolder(jsonl(SPENT.slice(0, 3))), "PRIOR_JOURNAL_NOT_CLEAR_NOT_TERMINAL_HALTED:attempt1"]
  ];
  for (const [name, f, code] of cases) {
    const b = snapshot(f.dir);
    const p = pre(ATTEMPT2, f.jdir);
    assert.equal(p.checksPassed, false, name);
    assert.ok(p.blockers.includes(code), `${name}: ${p.blockers}`);
    assert.deepEqual(snapshot(f.dir), b, `${name}: nothing written`);
  }
  // A journal whose file name matches but whose content is another manifest's run is not clear.
  const foreign = runFolder(jsonl([{ ...SPENT[0], manifestHash: "c".repeat(64) }, ...SPENT.slice(1)]));
  assert.ok(pre(ATTEMPT2, foreign.jdir).blockers.includes("PRIOR_JOURNAL_NOT_CLEAR_MANIFEST_MISMATCH:attempt1"));
  // A directory that is a prior journal's name (unreadable as a file) is not clear.
  const odd = runFolder(null); mkdirSync(join(odd.jdir, journalFileName(ORIGINAL_HASH)));
  assert.ok(pre(ATTEMPT2, odd.jdir).blockers.includes("PRIOR_JOURNAL_UNREADABLE:attempt1"));
  // Attempt 2 cannot replay itself; attempt 3 needs BOTH prior journals clear.
  writeFileSync(join(ok.jdir, journalFileName(A2.hash)), jsonl(SPENT.map((e, i) => (i === 0 ? { ...e, manifestHash: A2.hash } : e))));
  assert.ok(pre(ATTEMPT2, ok.jdir).blockers.includes("JOURNAL_EXISTS"));
  assert.deepEqual(pre({ ...ORIGINAL, attempt: 3 }, ok.jdir).journal.prior.map((p) => p.code), ["CLEAR_HALTED_BEFORE_WRITE", "CLEAR_HALTED_BEFORE_WRITE"]);
  const only1 = runFolder();
  assert.ok(pre({ ...ORIGINAL, attempt: 3 }, only1.jdir).blockers.includes("PRIOR_JOURNAL_MISSING:attempt2"));
  assert.deepEqual(snapshot(ok.dir).filter((p) => p.includes("2b7d851c1fbf") || p.includes("e4-manifest")), before.filter((p) => p.includes("2b7d851c1fbf") || p.includes("e4-manifest")));
});

// ---------- launcher ordering: refusal before prompt/network; a real attempt-2 run touches only its own journal ----------
function fakeGit() {
  const real = spawnSync("git", ["hash-object", "--", ...EXECUTE_SOURCES], { cwd: ROOT, encoding: "utf8" }).stdout.trim().split("\n");
  return (a) => a[0] === "rev-parse" ? { status: 0, stdout: `${SHA}\n` } : a[0] === "status" ? { status: 0, stdout: "" }
    : a[0] === "ls-tree" ? { status: 0, stdout: EXECUTE_SOURCES.map((p, i) => `100644 blob ${real[i]}\t${p}`).join("\n") } : { status: 0, stdout: real.join("\n") };
}
test("execute: a not-clear prior refuses at preflight with no prompt, no journal, no network; the original token is refused for attempt 2", async () => {
  for (const f of [runFolder(null), runFolder(jsonl(SPENT.slice(0, 3)))]) {
    const m = join(f.dir, "e4-manifest-attempt2.json"); writeFileSync(m, JSON.stringify(ATTEMPT2, null, 2));
    let prompts = 0, fetches = 0, journals = 0;
    const r = await runHappyExecute([m, f.jdir, "--confirm", A2.confirmToken, "--reviewed-commit", SHA], { git: fakeGit(), now: NOW, root: ROOT,
      prompt: async () => { prompts++; return { accountId: "1", clientSecret: "FAKE" }; }, fetchImpl: async () => { fetches++; },
      createJournal: () => { journals++; throw new Error("no"); } });
    assert.equal(r.output.stage, "preflight");
    assert.match(r.output.error, /^PREFLIGHT_FAILED:PRIOR_JOURNAL_/);
    assert.deepEqual([r.exitCode, prompts, fetches, journals], [EXIT.REFUSED, 0, 0, 0]);
  }
  const f = runFolder();
  const m = join(f.dir, "e4-manifest-attempt2.json"); writeFileSync(m, JSON.stringify(ATTEMPT2, null, 2));
  const r = await runHappyExecute([m, f.jdir, "--confirm", "E4-HAPPY-2b7d851c1fbf", "--reviewed-commit", SHA], { git: fakeGit(), now: NOW, root: ROOT,
    prompt: async () => { throw new Error("must not prompt"); } });
  assert.deepEqual([r.output.stage, r.output.error], ["preflight", "CONFIRM_TOKEN_MISMATCH"]);
});

test("execute: with the spent journal clear, attempt 2 runs once into its OWN new journal; the spent journal and manifest stay byte-identical", async () => {
  const f = runFolder();
  const m = join(f.dir, "e4-manifest-attempt2.json"); writeFileSync(m, JSON.stringify(ATTEMPT2, null, 2));
  const spentPath = join(f.jdir, journalFileName(ORIGINAL_HASH));
  const spentBefore = readFileSync(spentPath), manifestBefore = readFileSync(join(f.dir, "e4-manifest.json"));
  const calls = [];
  // Token refused => the reviewed runner halts at P0 before any write (no live behaviour is claimed by this mock).
  const fetchImpl = async (url, init = {}) => { calls.push(`${init.method} ${new URL(url).pathname}`); return new Response("{}", { status: 401 }); };
  const r = await runHappyExecute([m, f.jdir, "--confirm", A2.confirmToken, "--reviewed-commit", SHA], { git: fakeGit(), now: NOW, root: ROOT,
    prompt: async () => ({ accountId: "98765", clientSecret: "FAKE-secret" }), fetchImpl });
  assert.deepEqual([r.exitCode, r.output.status, r.output.manifestHash, r.output.journalFile, r.output.writes, r.output.halt.step],
    [EXIT.HALTED, "HALTED", A2.hash, journalFileName(A2.hash), { create: 0, cancel: 0 }, "P0_PREFLIGHT_PRICE"]);
  assert.deepEqual(calls, ["POST /v1/accessTokens"]);
  assert.ok(readFileSync(spentPath).equals(spentBefore));
  assert.ok(readFileSync(join(f.dir, "e4-manifest.json")).equals(manifestBefore));
  assert.deepEqual(readdirSync(f.jdir).sort(), [journalFileName(ORIGINAL_HASH), journalFileName(A2.hash)].sort());
  // The new journal is itself a clear prior for attempt 3, and attempt 2 can never run again here.
  const second = await runHappyExecute([m, f.jdir, "--confirm", A2.confirmToken, "--reviewed-commit", SHA], { git: fakeGit(), now: NOW, root: ROOT,
    prompt: async () => { throw new Error("must not prompt"); } });
  assert.deepEqual([second.output.stage, second.output.error], ["preflight", "PREFLIGHT_FAILED:JOURNAL_EXISTS"]);
  assert.equal(pre({ ...ORIGINAL, attempt: 3 }, f.jdir).checksPassed, true);
});

test("no global fetch was used", () => { assert.equal(globalFetchCalls, 0); });
