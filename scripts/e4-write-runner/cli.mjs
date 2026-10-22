#!/usr/bin/env node
// E4 write runner CLI — PLAN / DRY-RUN ONLY. Zero network: no transport, no credentials, no environment.
//   node scripts/e4-write-runner/cli.mjs --dry-run <manifest.json>
// There is deliberately no execute path on this branch (EXECUTION_WIRED = false): --execute is refused.
import { readFileSync } from "node:fs";
import { planRun, EXECUTION_WIRED } from "./runner.mjs";

const args = process.argv.slice(2);
const out = (obj, exit) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); process.exitCode = exit; };

if (args.includes("--execute")) {
  out({ ok: false, error: "EXECUTION_NOT_WIRED", executionWired: EXECUTION_WIRED }, 2);
} else if (args.length !== 2 || args[0] !== "--dry-run") {
  out({ ok: false, error: "USAGE", usage: "--dry-run <manifest.json>" }, 64);
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(args[1], "utf8")); } catch { manifest = null; }
  if (manifest === null) out({ ok: false, error: "MANIFEST_UNREADABLE" }, 65);
  else { const plan = planRun(manifest, { now: () => new Date() }); out(plan, plan.ok ? 0 : 1); }
}
