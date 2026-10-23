// E4 happy-path PREFLIGHT — local, read-only checks before any future execution (OFFLINE scaffold).
//
// No network, no credentials, no prompt, no environment, and it never creates or writes a file. It reports:
//  - the manifest verdict (errors / owner-input blockers), its SHA-256 and the confirm token;
//  - the journal file that a run would create exclusively (e4-journal-<hash12>.jsonl) and whether it already exists
//    (it must NOT) and whether the directory exists and is writable;
//  - the Node runtime (>= 20, AbortSignal.timeout available);
//  - git BLOB hashes of every source file the run would load, so the operator can compare them with the
//    reviewer-visible commit (`git ls-tree`) before anything is executed.
// The preflight itself never executes anything (`preflightExecutes: false`); execution is a separate, gated CLI mode.

import { readFileSync, statSync, accessSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHappyManifest, HAPPY_VERSION } from "./happy-path.mjs";
import { journalFileName } from "./journal.mjs";
import { expectedTotalMinor } from "./runner.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const PREFLIGHT_SOURCES = Object.freeze([
  "lib/hostaway-reservations.js",
  "scripts/e4-write-runner/runner.mjs",
  "scripts/e4-write-runner/journal.mjs",
  "scripts/e4-write-runner/happy-path.mjs",
  "scripts/e4-write-runner/side-effects.mjs",
  "scripts/e4-write-runner/happy-preflight.mjs",
  "scripts/e4-write-runner/happy-cli.mjs",
  "scripts/e4-transport/hostaway-transport.mjs",
  "scripts/e4-transport/credential-prompt.mjs",
  "scripts/e4-launcher/happy-execute.mjs"
]);

/** git's blob id: sha1("blob <bytes>\0" + content). Matches `git ls-tree` / `git hash-object`. */
export function gitBlobHash(buf) {
  return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

export function happyPreflight({ manifestText, journalDir, now = () => new Date(), root = ROOT } = {}) {
  const blockers = [];
  // Runtime
  const major = Number(String(process.versions.node).split(".")[0]);
  const node = { version: process.versions.node, ok: major >= 20 && typeof AbortSignal?.timeout === "function" };
  if (!node.ok) blockers.push("NODE_20_REQUIRED");
  // Manifest
  let parsed = null;
  try { parsed = JSON.parse(manifestText); } catch { parsed = null; }
  const v = parsed === null ? { ok: false, errors: ["MANIFEST_UNREADABLE"], blockers: [] } : validateHappyManifest(parsed, { now });
  const manifest = v.ok
    ? { ok: true, hash: v.hash, confirmToken: v.confirmToken, stay: { ...v.manifest.stay }, totalMinor: expectedTotalMinor(v.manifest.stay), currency: v.manifest.currency }
    : { ok: false, errors: v.errors, blockers: v.blockers };
  if (!v.ok) blockers.push(...(v.blockers.length ? v.blockers : ["MANIFEST_INVALID"]));
  // Journal (never created here)
  const journal = { dir: null, file: null, exists: null, dirWritable: false, ok: false };
  if (typeof journalDir === "string" && journalDir) {
    journal.dir = resolve(journalDir);
    try { journal.dirWritable = statSync(journal.dir).isDirectory() && (accessSync(journal.dir, constants.W_OK), true); } catch { journal.dirWritable = false; }
    if (v.ok) {
      journal.file = journalFileName(v.hash);
      try { statSync(join(journal.dir, journal.file)); journal.exists = true; } catch (e) { journal.exists = e && e.code === "ENOENT" ? false : null; }
    }
    journal.ok = journal.dirWritable && journal.exists === false;
  }
  if (!journal.dirWritable) blockers.push("JOURNAL_DIR_NOT_WRITABLE");
  if (journal.exists === true) blockers.push("JOURNAL_EXISTS");
  if (v.ok && journal.exists === null && journal.dirWritable) blockers.push("JOURNAL_STATE_UNKNOWN");
  // Provenance
  const sources = PREFLIGHT_SOURCES.map((p) => {
    try { return { path: p, gitBlob: gitBlobHash(readFileSync(join(root, p))) }; } catch { blockers.push(`SOURCE_MISSING:${p}`); return { path: p, gitBlob: null }; }
  });
  return Object.freeze({
    mode: "preflight", version: HAPPY_VERSION, network: "none", credentialsRequested: false, filesWritten: 0,
    preflightExecutes: false, node, manifest, journal, sources,
    checksPassed: blockers.length === 0, blockers
  });
}
