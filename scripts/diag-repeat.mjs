#!/usr/bin/env node
// scripts/diag-repeat.mjs — diagnostic repeat runner (local only; never deployed: /scripts is in .vercelignore).
//
// Runs ONE command one or more times and preserves, for every run, the complete stdout and stderr, the actual exit
// code (or signal), the command, the commit and a TAP summary. Stops at the first failing run.
//
//   node scripts/diag-repeat.mjs [--repeat N] [--out DIR] [--label NAME] -- <command> [args...]
//
//   --repeat N   runs (default 1; 1..MAX_REPEAT). Stops at the first failure.
//   --out DIR    where logs go (default: <os tmpdir>/mv-diag-runs/<timestamp>-<label>). Logs are never deleted.
//   --label      a short name used in the default directory.
//
// Files per run: run-NNN.stdout.log, run-NNN.stderr.log, run-NNN.json. Plus summary.json for the batch.
// Exit code: 0 if every run passed; otherwise the failing run's exit code (128 + signal number if it was killed).
// The command is spawned directly (no shell); output is written to files, not interpreted or altered.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { constants as osConstants } from "node:os";

const MAX_REPEAT = 20;

function usage(msg) {
  if (msg) console.error(`diag-repeat: ${msg}`);
  console.error("usage: node scripts/diag-repeat.mjs [--repeat N] [--out DIR] [--label NAME] -- <command> [args...]");
  process.exit(2);
}

export function parseArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) usage("a command is required after --");
  const opts = { repeat: 1, out: null, label: "run" };
  const head = argv.slice(0, sep);
  for (let i = 0; i < head.length; i++) {
    const k = head[i]; const v = head[i + 1];
    if (k === "--repeat") {
      if (!/^\d+$/.test(v || "") || Number(v) < 1 || Number(v) > MAX_REPEAT) usage(`--repeat must be an integer 1..${MAX_REPEAT}`);
      opts.repeat = Number(v); i++;
    } else if (k === "--out") { if (!v) usage("--out needs a directory"); opts.out = v; i++; }
    else if (k === "--label") { if (!/^[A-Za-z0-9._-]{1,40}$/.test(v || "")) usage("--label: 1-40 of [A-Za-z0-9._-]"); opts.label = v; i++; }
    else usage(`unknown option ${k}`);
  }
  opts.command = argv.slice(sep + 1);
  return opts;
}

function git(args) {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

/** Counts from node:test TAP output (the full output is always kept in the log files). */
export function tapSummary(text) {
  const num = (name) => { const m = new RegExp(`^# ${name} (\\d+)$`, "m").exec(text); return m ? Number(m[1]) : null; };
  const notOk = text.split("\n").filter((l) => /^\s*not ok \d+/.test(l)).slice(0, 50);
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), cancelled: num("cancelled"), skipped: num("skipped"), todo: num("todo"), notOk };
}

function runOnce(command, stdoutPath, stderrPath) {
  return new Promise((resolveRun) => {
    const out = createWriteStream(stdoutPath); const err = createWriteStream(stderrPath);
    const startedAt = new Date();
    let spawnError = null;
    const child = spawn(command[0], command.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    child.stdout.pipe(out); child.stderr.pipe(err);
    child.on("error", (e) => { spawnError = e; });
    child.on("close", (code, signal) => {
      const endedAt = new Date();
      let pending = 2; const done = () => { if (--pending === 0) resolveRun({ code, signal, spawnError, startedAt, endedAt }); };
      out.end(done); err.end(done);
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(opts.out || join(tmpdir(), "mv-diag-runs", `${stamp}-${opts.label}`));
  mkdirSync(dir, { recursive: true });
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]);
  const batch = { command: opts.command, cwd: process.cwd(), commit, worktreeDirty: dirty === null ? null : dirty.length > 0,
    node: process.version, repeatRequested: opts.repeat, stopOnFirstFailure: true, logDir: dir, startedAt: new Date().toISOString(), runs: [] };
  let exitCode = 0;
  for (let n = 1; n <= opts.repeat; n++) {
    const id = String(n).padStart(3, "0");
    const files = { stdout: join(dir, `run-${id}.stdout.log`), stderr: join(dir, `run-${id}.stderr.log`), meta: join(dir, `run-${id}.json`) };
    const r = await runOnce(opts.command, files.stdout, files.stderr);
    const runExit = r.spawnError ? 127 : r.signal ? 128 + (osConstants.signals[r.signal] || 0) : r.code;
    const meta = { run: n, command: opts.command, cwd: process.cwd(), commit, worktreeDirty: batch.worktreeDirty,
      startedAt: r.startedAt.toISOString(), endedAt: r.endedAt.toISOString(), durationMs: r.endedAt - r.startedAt,
      exitCode: r.code, signal: r.signal, spawnError: r.spawnError ? String(r.spawnError.message) : null, effectiveExit: runExit,
      summary: tapSummary(readFileSync(files.stdout, "utf8")), files };
    writeFileSync(files.meta, JSON.stringify(meta, null, 2) + "\n");
    batch.runs.push({ run: n, effectiveExit: runExit, exitCode: r.code, signal: r.signal, durationMs: meta.durationMs, summary: meta.summary });
    console.log(`run ${id}: exit=${r.code}${r.signal ? ` signal=${r.signal}` : ""} tests=${meta.summary.tests} pass=${meta.summary.pass} fail=${meta.summary.fail} -> ${files.meta}`);
    if (runExit !== 0) { exitCode = runExit; batch.stoppedAtRun = n; break; }
  }
  batch.endedAt = new Date().toISOString();
  batch.result = exitCode === 0 ? "all_passed" : "stopped_on_failure";
  batch.exitCode = exitCode;
  writeFileSync(join(dir, "summary.json"), JSON.stringify(batch, null, 2) + "\n");
  console.log(`${batch.result}: ${batch.runs.length} run(s), exit ${exitCode}; logs in ${dir}`);
  process.exit(exitCode);
}

main().catch((e) => { console.error(`diag-repeat: internal error: ${e.stack || e}`); process.exit(70); });
