#!/usr/bin/env node
// E4 happy-path CLI.
//   --dry-run <happy-manifest.json>                         zero network, no credentials
//   --preflight <happy-manifest.json> <journal-dir>         zero network, no credentials, writes nothing
//   --execute <happy-manifest.json> <journal-dir> --confirm E4-HAPPY-<hash12> --reviewed-commit <40-hex>
//        provenance + preflight first; only then a hidden credential prompt; see scripts/e4-launcher/happy-execute.mjs.
//        Having this code is NOT permission to run it: an owner execution approval is required.
import { readFileSync } from "node:fs";
import { planHappyRun } from "./happy-path.mjs";
import { happyPreflight } from "./happy-preflight.mjs";
import { runHappyExecute } from "../e4-launcher/happy-execute.mjs";

const args = process.argv.slice(2);
const out = (obj, exit) => { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); process.exitCode = exit; };

if (args[0] === "--execute") {
  const r = await runHappyExecute(args.slice(1));
  out(r.output, r.exitCode);
} else if (args[0] === "--preflight" && args.length === 3) {
  let text = null;
  try { text = readFileSync(args[1], "utf8"); } catch { text = null; }
  if (text === null) out({ ok: false, error: "MANIFEST_UNREADABLE" }, 65);
  else { const r = happyPreflight({ manifestText: text, journalDir: args[2] }); out(r, r.checksPassed ? 0 : 1); }
} else if (args.length !== 2 || args[0] !== "--dry-run") {
  out({ ok: false, error: "USAGE", usage: "--dry-run <manifest> | --preflight <manifest> <journal-dir> | --execute <manifest> <journal-dir> --confirm <token> --reviewed-commit <sha>" }, 64);
} else {
  let manifest;
  try { manifest = JSON.parse(readFileSync(args[1], "utf8")); } catch { manifest = null; }
  if (manifest === null) out({ ok: false, error: "MANIFEST_UNREADABLE" }, 65);
  else { const plan = planHappyRun(manifest, { now: () => new Date() }); out(plan, plan.ok ? 0 : 1); }
}
