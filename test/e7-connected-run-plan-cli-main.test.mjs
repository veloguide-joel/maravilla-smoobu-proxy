// E7 G3a — the native plan-INSPECT entrypoint (contract claude/e7-g3a-native-inspect-and-db-ingress.md §1, §6). OFFLINE: no DB, provider,
// network or credential. Plans / clocks / ids are SYNTHETIC (labelled); the source snapshot is the real repo closure (or a labelled tampered COPY).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, cpSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants as FS_CONSTANTS } from "node:fs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import { runPlanCommand } from "../scripts/e7-connected/run-plan-command.mjs";
import { createNativeAdapters, PRESENT_KEYS } from "../scripts/e7-connected/probe-cli-main.mjs";
import * as CLI from "../scripts/e7-connected/run-plan-cli-main.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline G3a CLI suite)"); };
const DIRS = [];
after(() => { globalThis.fetch = realFetch; for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const CLI_PATH = join(ROOT, "scripts/e7-connected/run-plan-cli-main.mjs");
const TRACER = join(ROOT, "test/fixtures/e7-g3a-fs-tracer.mjs");
const enc = new TextEncoder();
const u8 = (p, root = ROOT) => new Uint8Array(readFileSync(join(root, p)));
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); DIRS.push(d); return d; };
const MIN = 60_000; const DAY = 86_400_000;
const iso = (t) => new Date(t).toISOString();
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
/** a SYNTHETIC valid plan relative to `now` (shape = the accepted G1 fixture's; stay 30 days ahead; quote / authorization 2 / 1 minutes old) */
function planFor(now, over = () => {}, root = ROOT) {
  const p = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-g3a-0001", createdAt: iso(now - MIN),
    baseline: { repoCommit: "ab9d463a771044fa6c257f931ee8978cd3e28113", sourceDigest: sourceDigestV1(RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path, root) }))) },
    environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 },
    stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)),
    binding: { intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "MV-SYN0001", paymentIntentId: "pi_SYNTHETIC0000f1",
      stay: { arrival: ymd(now + 30 * DAY), departure: ymd(now + 32 * DAY), guests: 2 }, amountMinor: 23000, rateBps: 1000,
      quote: { totalMinor: 23000, currency: "USD", quotedAt: iso(now - 2 * MIN) }, authorizedAt: iso(now - MIN) } };
  over(p);
  return p;
}
const planFile = (dir, name, text, mode = 0o600) => { const f = join(dir, name); writeFileSync(f, text); chmodSync(f, mode); return f; };
const canonicalText = (p) => `${canonicalJson(p)}\n`;
const CLEAN_ENV = Object.freeze({ PATH: process.env.PATH });
/** the real native boot in a child process; optional fs tracer preload */
function cli(args, { trace = false, cliPath = CLI_PATH } = {}) {
  const r = spawnSync(process.execPath, [...(trace ? ["--import", pathToFileURL(TRACER).href] : []), cliPath, ...args], { env: CLEAN_ENV, encoding: "utf8", timeout: 60_000 });
  const lines = r.stdout.split("\n").filter(Boolean);
  const tr = (r.stderr.match(/^E7TRACE (.*)$/m) || [])[1];
  return { status: r.status, lines, out: lines.length === 1 ? JSON.parse(lines[0]) : null, stderr: r.stderr, trace: tr ? JSON.parse(tr) : null };
}

test("C1 INSPECT over a synthetic canonical plan + the real repo closure (child process): INSPECT_OK, exit 0, one line, executable false / permissions all false", () => {
  const d = tmp("g3a-plan-"); const now = Date.now();
  const f = planFile(d, "plan.json", canonicalText(planFor(now)));
  const r = cli(["inspect", "--plan", f]);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.lines.length, 1);
  assert.equal(r.out.schema, "e7-run-plan-native-cli-v1"); assert.equal(r.out.exitCode, 0);
  const x = r.out.result;
  assert.deepEqual([x.schema, x.outcome, x.code, x.executable], ["e7-run-plan-cli-result-v1", "INSPECT_OK", "PLAN_OK", false]);
  assert.ok(Object.values(x.permissions).every((v) => v === false) && Object.keys(x.permissions).length === 7);
  assert.ok(/^[0-9a-f]{64}$/.test(x.packageHash) && /^[0-9a-f]{64}$/.test(x.planHash));
  assert.equal(x.sourceDigest, sourceDigestV1(RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }))));
  assert.equal(x.package.executable, false);
  assert.ok(!r.stdout?.includes?.(d), "no path echoed");
  assert.ok(!r.lines[0].includes(d), "no path echoed");
});

/** the native main() in-process with a FIXED clock and the REAL accepted adapters over real files — byte-equal to the accepted command */
async function inproc(argv, now, extra = {}) {
  let line = null; let code = null;
  const proc = { argv: ["node", "cli", ...argv], platform: process.platform, versions: process.versions, execArgv: [], env: {}, getuid: () => process.getuid(),
    fsConstants: FS_CONSTANTS, stdout: { once: () => {}, write: (s, cb) => { line = s; cb(); return true; } }, exit: (c) => { code = c; }, setExitCode: () => {}, now: () => now, ...extra };
  await CLI.main(proc, CLI.defaultHooks());
  return { code, out: line === null ? null : JSON.parse(line) };
}
async function direct(planPath, now) {
  const nat = createNativeAdapters({ platform: process.platform, uid: process.getuid(), constants: FS_CONSTANTS, gate: () => {} });
  const envSnapshot = { schema: "e7-probe-env-snapshot-v1", nodeVersion: process.versions.node, platform: process.platform, execArgvCount: 0, uidAvailable: true,
    present: Object.fromEntries(PRESENT_KEYS.map((k) => [k, false])) };
  return runPlanCommand({ argv: ["inspect"], deps: { envSnapshot, planClock: () => now, readPlanFile: () => nat.readBounded(planPath, 16384),
    readSourceFiles: async (cl) => { const o = []; for (const p of cl) o.push({ path: p, bytes: await nat.readBounded(`${ROOT}/${p}`, 262144) }); return o; } } });
}

test("C2 accepted-command parity (fixed clock): the native INSPECT result is BYTE-EQUAL to runPlanCommand over the same files; the package re-derives via the accepted builder", async () => {
  const d = tmp("g3a-par-"); const now = Date.now();
  const p = planFor(now); const f = planFile(d, "plan.json", canonicalText(p));
  const a = await inproc(["inspect", "--plan", f], now); const b = await direct(f, now);
  assert.equal(a.code, 0); assert.equal(JSON.stringify(a.out.result), JSON.stringify(b));
  const built = buildRunPackageV1({ planBytes: enc.encode(canonicalText(p)), sourceEntries: RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) })),
    envSnapshot: { schema: "e7-probe-env-snapshot-v1", nodeVersion: process.versions.node, platform: process.platform, execArgvCount: 0, uidAvailable: true,
      present: Object.fromEntries(PRESENT_KEYS.map((k) => [k, false])) }, planClock: now });
  assert.equal(a.out.result.packageHash, built.packageHash);
});

test("C3 refusal / exit-code parity table (child process + in-process parity): usage, file refusals, malformed / non-canonical / oversize plans, pin mismatch, tampered source copy", async () => {
  const d = tmp("g3a-ref-"); const now = Date.now();
  const good = planFor(now);
  // usage (exit 2) — child
  for (const args of [[], ["inspect"], ["inspect", "--plan"], ["inspect", "--plan", "rel/plan.json"], ["inspect", "--plan", "/a/../b"], ["inspect", "--plan", "/a", "--x"],
    ["inspect", "--x", "/a"], ["Inspect", "--plan", "/a"], ["prepare-plan"], ["--plan", "/a", "inspect"]]) {
    const r = cli(args);
    assert.deepEqual([r.status, r.out && r.out.outcome, r.out && r.out.executable, r.lines.length], [2, "USAGE", false, 1], JSON.stringify(args));
  }
  // file-level and plan-level refusals: [label, path factory, expected code] — child exit 4 AND equal to the accepted command in-process
  const big = planFile(d, "big.json", "x".repeat(16385));
  const dirPath = join(d, "adir"); mkdirSync(dirPath);
  const real = planFile(d, "real.json", canonicalText(good)); const link = join(d, "link.json"); symlinkSync(real, link);
  const cases = [
    ["missing", join(d, "nope.json"), "PLAN_READ_FAILED"],
    ["directory", dirPath, "PLAN_READ_FAILED"],
    ["symlink (O_NOFOLLOW)", link, "PLAN_READ_FAILED"],
    ["oversize", big, "PLAN_READ_FAILED"],
    ["not json", planFile(d, "nj.json", "{not json\n"), "PLAN_NOT_JSON"],
    ["non-canonical", planFile(d, "pretty.json", `${JSON.stringify(good, null, 1)}\n`), "PLAN_NOT_CANONICAL"],
    ["pin mismatch", planFile(d, "pin.json", canonicalText(planFor(now, (p) => { p.baseline.sourceDigest = "0".repeat(64); }))), "SOURCE_DIGEST_MISMATCH"],
    ["stale quote", planFile(d, "stale.json", canonicalText(planFor(now, (p) => { p.binding.quote.quotedAt = iso(now - 31 * MIN); p.binding.authorizedAt = iso(now - 30 * MIN); }))), "QUOTE_TOO_OLD"],
    ["listing not allowed", planFile(d, "lst.json", canonicalText(planFor(now, (p) => { p.listing.id = 871001; }))), "LISTING_NOT_ALLOWED"]
  ];
  for (const [label, f, code] of cases) {
    const r = cli(["inspect", "--plan", f]);
    assert.deepEqual([r.status, r.out.exitCode, r.out.result.outcome, r.out.result.code, r.out.result.executable], [4, 4, "PLAN_REFUSED", code, false], `${label}: ${r.lines[0]}`);
    assert.ok(!r.lines[0].includes(d), `${label}: no path echoed`);
    const a = await inproc(["inspect", "--plan", f], now); const b = await direct(f, now);
    assert.equal(JSON.stringify(a.out.result), JSON.stringify(b), `${label}: in-process parity with the accepted command`);
  }
  // tampered source: a labelled COPY of the repo tree with ONE closure file changed → the copy's CLI refuses the original plan
  const tree = tmp("g3a-tree-");
  for (const top of ["scripts", "lib", "package.json", "package-lock.json"]) cpSync(join(ROOT, top), join(tree, top), { recursive: true });
  if (existsSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules"), join(tree, "node_modules"));
  const victim = "lib/direct-pricing.js"; assert.ok(RUN_PLAN_CLOSURE.includes(victim));
  writeFileSync(join(tree, victim), `${readFileSync(join(tree, victim), "utf8")}\n// tampered (TEST-ONLY copy)\n`);
  const r = cli(["inspect", "--plan", real], { cliPath: join(tree, "scripts/e7-connected/run-plan-cli-main.mjs") });
  assert.deepEqual([r.status, r.out.result.code], [4, "SOURCE_DIGEST_MISMATCH"], r.lines[0]);
  // the untampered copy accepts the same plan (control: the refusal is the tamper, not the copy)
  writeFileSync(join(tree, victim), readFileSync(join(ROOT, victim)));
  const ok = cli(["inspect", "--plan", real], { cliPath: join(tree, "scripts/e7-connected/run-plan-cli-main.mjs") });
  assert.deepEqual([ok.status, ok.out.result.outcome], [0, "INSPECT_OK"], ok.lines[0]);
});

test("C4 execute / unknown / usage refuse FIRST: no fs call beyond Node's own entry-file load and no module beyond the three static built-ins (child tracer); in-process: no proc member but argv / stdout / exit read, no hook called", async () => {
  const d = tmp("g3a-exe-"); const f = planFile(d, "plan.json", canonicalText(planFor(Date.now())));
  // G3b CHANGED ASSERTION (contract claude/e7-g3b-native-execute.md §5): execute is now implemented ONLY through its full 13-flag grammar; an
  // incomplete execute is USAGE (exit 2) — the zero-access refusal-before-access checks below are unchanged.
  for (const [args, outcome, status] of [[["execute"], "USAGE", 2], [["execute", "--plan", f, "--expect-source-digest", "0".repeat(64)], "USAGE", 2],
    [["unknown"], "USAGE", 2], [[], "USAGE", 2], [["inspect", "--plan", "rel"], "USAGE", 2]]) {
    const r = cli(args, { trace: true });
    assert.deepEqual([r.status, r.out.outcome, r.out.executable], [status, outcome, false], JSON.stringify(args));
    assert.ok(r.trace, "tracer reported");
    // the ONLY fs call is Node's own ESM loader reading the ENTRY file (diagnosed in FIRST TAP: node:internal/modules/esm/load getSourceSync)
    const entry = pathToFileURL(CLI_PATH).href;
    assert.deepEqual(r.trace.calls, [`fs.openSync ${entry}`], `${JSON.stringify(args)}: no fs call by the CLI`);
    // resolutions = the entry + its three STATIC built-in imports only (diagnosed in rerun 1); command / adapters / planner never loaded
    assert.deepEqual(r.trace.resolved.filter((s) => s !== CLI_PATH && s !== entry), ["node:process", "node:fs", "node:url"], `${JSON.stringify(args)}: nothing beyond the static built-ins`);
  }
  // control: INSPECT under the same tracer DOES load the accepted command + adapters and reads files
  { const r = cli(["inspect", "--plan", f], { trace: true });
    assert.equal(r.status, 4, "tracer adds an exec flag → the accepted env evaluation refuses (ENV_EXEC_FLAGS)"); assert.equal(r.out.result.code, "ENV_REFUSED");
    assert.ok(r.trace.resolved.some((s) => s.endsWith("run-plan-command.mjs")) && r.trace.resolved.some((s) => s.endsWith("probe-cli-main.mjs"))); }
  // in-process: every proc member read is counted; execute / unknown touch only argv, stdout, setExitCode, exit
  for (const [argv, outcome] of [[["execute"], "USAGE"], [["nope"], "USAGE"]]) {   // G3b changed assertion (see above)
    const touched = new Set(); let hookCalls = 0; let line = null;
    const base = { argv: ["node", "cli", ...argv], platform: "linux", versions: process.versions, execArgv: [], env: {}, getuid: () => 0, fsConstants: FS_CONSTANTS,
      stdout: { once: () => {}, write: (s, cb) => { line = s; cb(); return true; } }, exit: () => {}, setExitCode: () => {}, now: () => 1 };
    const proc = new Proxy(base, { get(t, k) { touched.add(String(k)); return t[k]; } });
    const hooks = { importCommand: () => { hookCalls += 1; }, importNative: () => { hookCalls += 1; }, importLimits: () => { hookCalls += 1; }, repoRoot: "/nonexistent" };
    await CLI.main(proc, hooks);
    assert.equal(JSON.parse(line).outcome, outcome);
    assert.deepEqual([...touched].sort(), ["argv", "exit", "setExitCode", "stdout"], `${outcome}: only argv / stdout / exit touched`);
    assert.equal(hookCalls, 0, `${outcome}: no import hook`);
  }
});

test("C5 hostile proc / argv inputs refuse code-only (no throw, no echo); boot import failure / unsupported platform; source invariants (inert on import, built-in-only static imports, no runReservationAbortR1)", async () => {
  // hostile argv: getter, non-strings, proxy-throwing iterator → USAGE, never a throw
  for (const argv of [["node", "cli", 1], ["node", "cli", { toString: () => "inspect" }], null, { get length() { throw new Error("x"); } }]) {
    let line = null;
    await CLI.main({ argv, stdout: { once: () => {}, write: (s, cb) => { line = s; cb(); } }, exit: () => {}, setExitCode: () => {} }, CLI.defaultHooks());
    assert.equal(JSON.parse(line).outcome, "USAGE");
  }
  { let line = null; await CLI.main({ argv: ["n", "c", "inspect", "--plan", "/x"], platform: "win32", fsConstants: FS_CONSTANTS, stdout: { once: () => {}, write: (s, cb) => { line = s; cb(); } },
    exit: () => {}, setExitCode: () => {} }, CLI.defaultHooks()); assert.deepEqual([JSON.parse(line).outcome, JSON.parse(line).exitCode], ["BOOT_UNSUPPORTED", 3]); }
  { let line = null; await CLI.main({ argv: ["n", "c", "inspect", "--plan", "/x"], stdout: { once: () => {}, write: (s, cb) => { line = s; cb(); } }, exit: () => {}, setExitCode: () => {} },
    { importNative: () => Promise.reject(new Error("SECRET-ish /path")), importCommand: () => ({}), importLimits: () => ({}), repoRoot: "/" });
    assert.equal(line, `${JSON.stringify({ schema: "e7-run-plan-native-cli-v1", outcome: "BOOT_IMPORT_FAILED", executable: false, exitCode: 1 })}\n`); }
  // stdout failure → exit 9 (no second write)
  { let code = null; let writes = 0; await CLI.main({ argv: ["n", "c", "execute"], stdout: { once: () => {}, write: (s, cb) => { writes += 1; cb(new Error("EPIPE")); } }, exit: (c) => { code = c; }, setExitCode: () => {} }, CLI.defaultHooks());
    assert.deepEqual([code, writes], [9, 1]); }
  const src = readFileSync(CLI_PATH, "utf8");
  assert.deepEqual([...src.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((x) => x[1]), ["node:process", "node:fs", "node:url"], "static imports: built-ins only");
  // G3b CHANGED ASSERTION (§5): + the launcher and two built-ins, imported only on the verified execute path
  assert.deepEqual([...src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((x) => x[1]).sort(), ["./probe-cli-main.mjs", "./probe-env-preflight.mjs", "./run-plan-command.mjs", "./run-plan-v1.mjs", "./run-r1-launcher.mjs", "node:crypto", "node:fs/promises"], "fixed dynamic specifiers only");   // + probe-env-preflight (root review of 128ac08, H2: accepted env evaluation before the launcher / pg import)
  const code = src.replace(/\/\/.*$/gm, "");
  // G3b CHANGED ASSERTION (§5): "credential" (a flag name) and "setTimeout" (native timers) may now appear; the CLI still never names the consumer / pg / https / DB reader
  // (the reviewed NATIVE_EXEC_SOURCES / NATIVE_EXTERNALS literal lists NAME closure paths as DATA — they are removed before this scan)
  const codeNoLists = code.replace(/export const NATIVE_EXEC_SOURCES = Object\.freeze\(\[[\s\S]*?\]\);/, "").replace(/export const NATIVE_EXTERNALS = Object\.freeze\(\[[^\]]*\]\);/, "");
  for (const bad of ["runReservationAbortR1", "run-core-abort", "\"pg\"", "fetch(", "https", "readDbLoginFiles", "writeFile"]) assert.ok(!codeNoLists.includes(bad), bad);
  assert.equal((code.match(/import\.meta\.main === true/g) || []).length, 1, "the only top-level effect");
  // importing the module does nothing (this test process imported it at the top; no output / exit happened)
  assert.equal(typeof CLI.main, "function");
});

const PROC_TRACER = join(ROOT, "test/fixtures/e7-g3a-process-tracer.mjs");
/** the REAL native boot (import.meta.main) under a process-property tracer: names of INSPECT-only process properties read BY THE CLI */
function procTrace(args, cliPath = CLI_PATH) {
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(PROC_TRACER).href, cliPath, ...args], { env: CLEAN_ENV, encoding: "utf8", timeout: 60_000 });
  const m = r.stderr.match(/^E7PROC (.*)$/m);
  const lines = r.stdout.split("\n").filter(Boolean);
  return { status: r.status, out: lines.length === 1 ? JSON.parse(lines[0]) : null, seen: m ? JSON.parse(m[1]) : null, stderr: r.stderr };
}
test("C6 (root review of 079e8da) the REAL native boot: execute / unknown / malformed inspect read NONE of process.platform / versions / execArgv / env / getuid; the INSPECT control reads them only AFTER mode selection", () => {
  const d = tmp("g3a-boot-"); const f = planFile(d, "plan.json", canonicalText(planFor(Date.now())));
  // G3b CHANGED ASSERTION (contract claude/e7-g3b-native-execute.md §5): execute is now implemented ONLY through its full 13-flag grammar; an
  // incomplete execute is USAGE (exit 2) — the zero-access refusal-before-access checks below are unchanged.
  for (const [args, outcome, status] of [[["execute"], "USAGE", 2], [["execute", "--plan", f], "USAGE", 2], [["unknown"], "USAGE", 2],
    [[], "USAGE", 2], [["inspect", "--plan", "rel/plan.json"], "USAGE", 2], [["inspect", "--plan", f, "--extra"], "USAGE", 2]]) {
    const r = procTrace(args);
    assert.deepEqual([r.status, r.out && r.out.outcome], [status, outcome], `${JSON.stringify(args)}: ${r.stderr}`);
    assert.deepEqual(r.seen, [], `${JSON.stringify(args)}: no INSPECT-only process property read by the CLI`);
  }
  // control: the instrumentation DOES see the CLI's reads on INSPECT (the preload adds an exec flag → the accepted env evaluation refuses, after the reads)
  const c = procTrace(["inspect", "--plan", f]);
  assert.equal(c.status, 4); assert.equal(c.out.result.code, "ENV_REFUSED");
  assert.deepEqual([...new Set(c.seen)].sort(), ["env", "execArgv", "getuid", "platform", "versions"], `inspect control: ${JSON.stringify(c.seen)}`);
});
