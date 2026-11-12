// E7 N2 reconcile CLI (R-B Step B) — unit tests, no DB / network. Grammar, boot ordering (argv → platform → env presence → closure → imports →
// env evaluation → launch), closure coverage (independent re-scan), inertness, the restated boot env list, pure plan / namespace helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, constants as FS_CONSTANTS } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import * as C from "../scripts/e7-connected/reconcile-cli-main.mjs";
import * as NCLI from "../scripts/e7-connected/run-plan-cli-main.mjs";
import { RUN_PLAN_CLOSURE } from "../scripts/e7-connected/run-plan-v1.mjs";
import { R1_EXECUTOR_CLOSURE } from "../scripts/e7-connected/run-binding-r1.mjs";
import { runDirsOk, decodeRecoveryPlan } from "../scripts/e7-connected/reconcile-launch-r1.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const H = "a".repeat(64); const UUID = "11111111-2222-4333-8444-555555555555";
const P = "/home/o/.maravilla-private";
const good = (o = {}) => {
  const f = { "--native-run-dir": `${P}/runs/native-run-0001`, "--reconcile-run-dir": `${P}/runs/reconcile-run-0001`, "--recovery-plan-b64": "eyJhIjoxfQ==",
    "--expect-recovery-plan-sha256": H, "--expect-native-package-hash": H, "--expect-executor-digest": H, "--expect-trusted-head": `12:${H}`,
    "--expect-reconcile-digest": H, "--intent": UUID, "--provider-credentials": `${P}/provider.json`, "--db-app": `${P}/app.login.json`,
    "--db-report": `${P}/report.login.json`, "--db-ca": "none", ...o };
  return ["reconcile", ...Object.entries(f).filter(([, v]) => v !== undefined).flat()];
};
/** a proc whose every non-argv member THROWS on read: proves nothing else is touched before the decision */
const strictProc = (tokens, out) => {
  const boom = () => { throw new Error("read before the decision"); };
  return { argv: ["node", "cli", ...tokens], get platform() { return boom(); }, get fsConstants() { return boom(); }, get env() { return boom(); },
    get getuid() { return boom(); }, get versions() { return boom(); }, get execArgv() { return boom(); }, onSignal: boom,
    stdout: { once: () => {}, write: (s, cb) => { out.push(JSON.parse(s)); cb(); return true; } }, exit: () => {}, setExitCode: () => {} };
};
const noImports = { importNative: () => { throw new Error("import"); }, importEnvPreflight: () => { throw new Error("import"); }, importLaunch: () => { throw new Error("import"); }, repoRoot: ROOT };

test("RCU1 grammar: exact flag set; unknown / duplicate / missing / malformed / repeated paths → USAGE before ANY other proc read", async () => {
  assert.ok(C.reconcileFlagsOf(good().slice(0)), "the good line parses");
  const bad = [
    good({ "--db-ca": undefined }), [...good(), "--extra", "x"], good({ "--intent": "not-a-uuid" }), good({ "--expect-trusted-head": `0:${H}` }),
    good({ "--expect-trusted-head": `12:${"A".repeat(64)}` }), good({ "--recovery-plan-b64": "not base64!" }), good({ "--recovery-plan-b64": "abc" }),
    good({ "--native-run-dir": "relative/dir" }), good({ "--native-run-dir": `${P}/runs/../x` }), good({ "--db-app": `${P}/report.login.json` }),
    good().map((t, i, a) => (a[i - 1] === "--intent" ? "AAAAAAAA-2222-4333-8444-555555555555" : t)), ["execute", ...good().slice(1)], []];
  const dup = good(); dup[dup.indexOf("--db-ca")] = "--intent"; dup[dup.indexOf("--intent") + 1] = UUID; bad.push(dup);
  for (const t of bad) { const out = []; await C.main(strictProc(t, out), noImports); assert.deepEqual([out.length, out[0]?.outcome, out[0]?.exitCode], [1, "USAGE", 2], JSON.stringify(t).slice(0, 120)); }
});

test("RCU2 boot ordering: NODE_PG_FORCE_NATIVE presence → BOOT_ENV_REFUSED before the closure read; wrong digest → CLOSURE_REFUSED before ANY import; NODE_OPTIONS → accepted env evaluation refuses BEFORE the launch import", async () => {
  const base = (env, hooks, digest = H) => { const out = []; let closureRead = false;
    const proc = { argv: ["node", "cli", ...good({ "--expect-reconcile-digest": digest })], platform: "linux", fsConstants: FS_CONSTANTS, env, getuid: () => process.getuid(),
      versions: process.versions, execArgv: [], onSignal: () => {}, stdout: { once: () => {}, write: (s, cb) => { out.push(JSON.parse(s)); cb(); return true; } }, exit: () => {}, setExitCode: () => {} };
    return { out, proc, hooks: { ...noImports, ...hooks, repoRoot: hooks.repoRoot ?? ROOT }, get closureRead() { return closureRead; } }; };
  { const x = base({ NODE_PG_FORCE_NATIVE: "" }, { repoRoot: "/nonexistent-root" }); await C.main(x.proc, x.hooks);
    assert.deepEqual([x.out[0].outcome, x.out[0].code], ["BOOT_ENV_REFUSED", "PG_NATIVE_SELECTOR_PRESENT"]); }
  { const x = base({}, {}); await C.main(x.proc, x.hooks);
    assert.deepEqual([x.out[0].outcome, x.out[0].code], ["CLOSURE_REFUSED", "RECONCILE_DIGEST_MISMATCH"], "no import was attempted (they throw)"); }
  { const x = base({}, { repoRoot: "/nonexistent-root" }); await C.main(x.proc, x.hooks); assert.deepEqual([x.out[0].outcome, x.out[0].code], ["CLOSURE_REFUSED", "RECONCILE_CLOSURE_UNREADABLE"]); }
  const e = await C.readReconcileClosure(ROOT, FS_CONSTANTS); const d = await C.reconcileClosureDigest(e);
  { let launchImported = false;
    const x = base({ NODE_OPTIONS: "--x" }, { importNative: () => import("../scripts/e7-connected/probe-cli-main.mjs"), importEnvPreflight: () => import("../scripts/e7-connected/probe-env-preflight.mjs"),
      importLaunch: () => { launchImported = true; throw new Error("no"); } }, d);
    await C.main(x.proc, x.hooks); assert.deepEqual([x.out[0].outcome, launchImported], ["BOOT_ENV_REFUSED", false]); }
});

test("RCU3 closure: RECONCILE_EXEC_SOURCES = an INDEPENDENT re-scan of every static / dynamic relative import reachable from the CLI (+ package.json / lock); covers the frozen core / executors / journal / launch; native lists unchanged; restated boot env list equal", () => {
  const RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  const seen = new Set(); const q = ["scripts/e7-connected/reconcile-cli-main.mjs"];
  while (q.length) { const f = q.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(RE)) q.push(normalize(join(dirname(f), m[1]))); }
  assert.deepEqual([...C.RECONCILE_EXEC_SOURCES], [...seen, "package.json", "package-lock.json"].sort());
  for (const f of ["reconcile-cli-main", "reconcile-launch-r1", "reconcile-core-r1", "reconcile-executors-r1", "reconcile-journal-r1"]) assert.ok(C.RECONCILE_EXEC_SOURCES.includes(`scripts/e7-connected/${f}.mjs`), f);
  for (const L of [NCLI.NATIVE_EXEC_SOURCES, RUN_PLAN_CLOSURE, R1_EXECUTOR_CLOSURE]) assert.ok(!L.some((p) => p.includes("reconcile")), "no R1 list includes reconcile files");
  assert.deepEqual([...C.BOOT_REFUSED_ENV], [...NCLI.BOOT_REFUSED_ENV]);
  assert.deepEqual([...C.RECONCILE_EXTERNALS], [...NCLI.NATIVE_EXTERNALS]);
  // static imports of the CLI are built-ins only
  const src = readFileSync(join(ROOT, "scripts/e7-connected/reconcile-cli-main.mjs"), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";$/gm)) assert.ok(m[1].startsWith("node:"), m[1]);
});

test("RCU4 inert on import (no output, no listener) and the pure helpers: run dir namespace; canonical ROOT-pinned plan bytes with exact hash", async () => {
  const before = process.listenerCount("SIGINT");
  await import(`../scripts/e7-connected/reconcile-cli-main.mjs?inert=${Date.now()}`);
  assert.equal(process.listenerCount("SIGINT"), before);
  assert.equal(runDirsOk(`${P}/runs/native-run-0001`, `${P}/runs/reconcile-run-0001`, ROOT), null);
  for (const [a, b] of [[`/x/private/runs/a-native-01`, `/x/private/runs/b-reconcile-01`], [`${P}/runs/native-run-0001`, `/y/.maravilla-private/runs/reconcile-run-0001`],
    [`${P}/runs/native-run-0001`, `${P}/runs/native-run-0001`], [`${P}/x/native-run-0001`, `${P}/x/reconcile-run-0001`], [`${P}/runs/native-run-0001`, `${P}/runs/BAD`]])
    assert.equal(runDirsOk(a, b, ROOT), "RUN_DIR_NAMESPACE_INVALID", `${a} ${b}`);
  assert.equal(runDirsOk(`${ROOT}/.maravilla-private/runs/native-run-0001`, `${ROOT}/.maravilla-private/runs/reconcile-run-0001`, ROOT), "RUN_DIR_INSIDE_REPO");
  const plan = { a: 1 }; const bytes = Buffer.from(canonicalJson(plan)); const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(decodeRecoveryPlan(bytes.toString("base64"), "b".repeat(64)).code, "RECOVERY_PLAN_HASH_MISMATCH");
  assert.notEqual(decodeRecoveryPlan(bytes.toString("base64"), sha).ok, true, "a non-plan object is refused by the accepted validatePlanR1");
  const nc = Buffer.from('{ "a": 1 }'); assert.equal(decodeRecoveryPlan(nc.toString("base64"), createHash("sha256").update(nc).digest("hex")).code, "RECOVERY_PLAN_NOT_CANONICAL");
});
