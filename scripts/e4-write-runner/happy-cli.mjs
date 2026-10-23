#!/usr/bin/env node
// E4 happy-path CLI — PLAN / DRY-RUN / PREFLIGHT ONLY. Zero network: no transport, no credentials, no environment.
//   node scripts/e4-write-runner/happy-cli.mjs --dry-run <happy-manifest.json>
//   node scripts/e4-write-runner/happy-cli.mjs --preflight <happy-manifest.json> <journal-dir>
// No execute path exists (HAPPY_EXECUTION_WIRED = false): --execute is refused. Preflight writes no file.
import { readFileSync } from "node:fs";
import { planHappyRun, HAPPY_EXECUTION_WIRED } from "./happy-path.mjs";
import { happyPreflight } from "./happy-preflight.mjs";

const args = process.argv.slice(2);
const out = (obj, exit) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); process.exitCode = exit; };

if (args.includes("--execute")) {
  out({ ok: false, error: "EXECUTION_NOT_WIRED", executionWired: HAPPY_EXECUTION_WIRED }, 2);
} else if (args[0] === "--preflight" && args.length === 3) {
  let text = null;
  try { text = readFileSync(args[1], "utf8"); } catch { text = null; }
  if (text === null) out({ ok: false, error: "MANIFEST_UNREADABLE" }, 65);
  else { const r = happyPreflight({ manifestText: text, journalDir: args[2] }); out(r, r.checksPassed ? 0 : 1); }
} else if (args.length !== 2 || args[0] !== "--dry-run") {
  out({ ok: false, error: "USAGE", usage: "--dry-run <happy-manifest.json> | --preflight <happy-manifest.json> <journal-dir>" }, 64);
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(args[1], "utf8")); } catch { manifest = null; }
  if (manifest === null) out({ ok: false, error: "MANIFEST_UNREADABLE" }, 65);
  else { const plan = planHappyRun(manifest, { now: () => new Date() }); out(plan, plan.ok ? 0 : 1); }
}
