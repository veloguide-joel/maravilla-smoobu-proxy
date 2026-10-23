// E4 happy-path EXECUTE orchestration (OFFLINE FOR REVIEW; present code is NOT permission to run it).
//
//   node scripts/e4-write-runner/happy-cli.mjs --execute <manifest.json> <journal-folder> \
//        --confirm E4-HAPPY-<hash12> --reviewed-commit <40-hex commit>
//
// Order (every step is fatal; nothing below a failed step runs):
//   1. strict arguments;
//   2. provenance, read-only git, NO network and NO prompt:
//        HEAD == --reviewed-commit; `git status` shows no change/untracked file in any runtime source;
//        for every runtime source, `git hash-object` (working file) == `git ls-tree <reviewed-commit>` blob;
//   3. preflight (manifest valid and approvable, exclusive journal absent, folder writable, Node >= 20);
//   4. --confirm must equal the manifest's confirm token;
//   5. ONLY NOW the hidden TTY credential prompt (account id + secret; typing or private paste in the owner's own
//      terminal; never argv/env/file/chat). Abort => exit, no journal, no network;
//   6. exclusive durable journal created; injected transport (one mint, no retry/re-mint) + reservation-scoped
//      side-effect probe; the reviewed happy-path runner (1 create + 1 cancel max, halt on any doubt);
//   7. journal closed in `finally`; a SANITIZED summary is printed (codes, ids, our ref, dates, minor units);
//      exit 0 only for COMPLETED, 3 for HALTED.
// Credentials are handed to the transport once and the local reference is dropped; nothing secret is returned,
// printed or logged. No guest details are printed.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { happyPreflight, PREFLIGHT_SOURCES } from "../e4-write-runner/happy-preflight.mjs";
import { executeHappyRun } from "../e4-write-runner/happy-path.mjs";
import { createFileJournal } from "../e4-write-runner/journal.mjs";
import { createSideEffectProbe } from "../e4-write-runner/side-effects.mjs";
import { createHostawayTransport } from "../e4-transport/hostaway-transport.mjs";
import { promptHostawayCredentials } from "../e4-transport/credential-prompt.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const EXECUTE_SOURCES = PREFLIGHT_SOURCES; // includes this file and the CLI
export const EXIT = Object.freeze({ COMPLETED: 0, REFUSED: 2, HALTED: 3, INTERNAL: 70, USAGE: 64 });

/** argv after "--execute" -> { ok, manifestPath, journalDir, confirm, reviewedCommit } | { ok:false, code } */
export function parseExecuteArgs(argv) {
  const a = Array.isArray(argv) ? [...argv] : [];
  if (a.length !== 6) return { ok: false, code: "USAGE" };
  const [manifestPath, journalDir, ...flags] = a;
  const opts = {};
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i];
    if (!["--confirm", "--reviewed-commit"].includes(k) || Object.prototype.hasOwnProperty.call(opts, k)) return { ok: false, code: "USAGE" };
    opts[k] = flags[i + 1];
  }
  if (!manifestPath || manifestPath.startsWith("--") || !journalDir || journalDir.startsWith("--")) return { ok: false, code: "USAGE" };
  if (typeof opts["--reviewed-commit"] !== "string" || !/^[0-9a-f]{40}$/.test(opts["--reviewed-commit"])) return { ok: false, code: "REVIEWED_COMMIT_INVALID" };
  if (typeof opts["--confirm"] !== "string" || !/^E4-HAPPY-[0-9a-f]{12}$/.test(opts["--confirm"])) return { ok: false, code: "CONFIRM_TOKEN_INVALID" };
  return { ok: true, manifestPath, journalDir, confirm: opts["--confirm"], reviewedCommit: opts["--reviewed-commit"] };
}

export function makeGit(root = ROOT) {
  return (args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 });
    return { status: r.status, stdout: typeof r.stdout === "string" ? r.stdout : "" };
  };
}

/** Read-only provenance check. -> { ok: true } | { ok: false, code } (paths only, never content). */
export function verifyProvenance({ reviewedCommit, git, sources = EXECUTE_SOURCES }) {
  const head = git(["rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) return { ok: false, code: "GIT_UNAVAILABLE" };
  if (head.stdout.trim() !== reviewedCommit) return { ok: false, code: "HEAD_NOT_REVIEWED_COMMIT" };
  const st = git(["status", "--porcelain", "--untracked-files=all", "--", ...sources]);
  if (st.status !== 0) return { ok: false, code: "GIT_UNAVAILABLE" };
  if (st.stdout.trim() !== "") return { ok: false, code: "SOURCE_DIRTY" };
  const tree = git(["ls-tree", reviewedCommit, "--", ...sources]);
  if (tree.status !== 0) return { ok: false, code: "GIT_UNAVAILABLE" };
  const committed = new Map();
  for (const line of tree.stdout.split("\n").filter(Boolean)) {
    const m = /^(\d{6}) (blob) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) committed.set(m[4], m[3]);
  }
  const work = git(["hash-object", "--", ...sources]);
  if (work.status !== 0) return { ok: false, code: "SOURCE_MISSING" };
  const hashes = work.stdout.trim().split("\n");
  if (hashes.length !== sources.length) return { ok: false, code: "SOURCE_MISSING" };
  for (let i = 0; i < sources.length; i++) {
    const want = committed.get(sources[i]);
    if (!want) return { ok: false, code: `SOURCE_NOT_IN_REVIEWED_COMMIT:${sources[i]}` };
    if (hashes[i] !== want) return { ok: false, code: `SOURCE_MISMATCH:${sources[i]}` };
  }
  return { ok: true };
}

/** Sanitized summary of the runner's report (already codes/ids only); explicit allowlist, nothing else. */
export function summarize(report, extra) {
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && Object.prototype.hasOwnProperty.call(o, k)).map((k) => [k, o[k]]));
  return {
    status: report.status, version: report.version, manifestHash: report.manifestHash,
    writes: report.writes, requests: report.requests ?? null,
    halt: report.halt ? pick(report.halt, ["step", "code", "mismatches", "httpStatus", "observedTotalMinor", "itemsSeen"]) : null,
    steps: (report.steps || []).map((s) => pick(s, ["step", "code", "reservationId", "totalMinor", "httpStatus"])),
    reconcile: (report.reconcile || []).map((r) => pick(r, ["step", "ref", "reservationId", "readCode", "reservationStatus", "lookupCode", "foundReservationId"])),
    ...extra
  };
}

/**
 * Run the execute path. All side-effectful dependencies are injectable for tests:
 *   { git, readText, prompt, fetchImpl, createJournal, execute, now, root }.
 * Returns { exitCode, output } where output is a plain, sanitized object.
 */
export async function runHappyExecute(argv, deps = {}) {
  const root = deps.root ?? ROOT;
  const refuse = (code, extra = {}) => ({ exitCode: code === "USAGE" ? EXIT.USAGE : EXIT.REFUSED,
    output: { ok: false, mode: "execute", stage: extra.stage ?? "arguments", error: code, credentialsRequested: false, network: "none" } });
  const args = parseExecuteArgs(argv);
  if (!args.ok) return refuse(args.code);
  const git = deps.git ?? makeGit(root);
  const prov = verifyProvenance({ reviewedCommit: args.reviewedCommit, git });
  if (!prov.ok) return refuse(prov.code, { stage: "provenance" });
  let manifestText = null;
  try { manifestText = (deps.readText ?? ((p) => readFileSync(p, "utf8")))(args.manifestPath); } catch { manifestText = null; }
  if (manifestText === null) return refuse("MANIFEST_UNREADABLE", { stage: "preflight" });
  const now = deps.now ?? (() => new Date());
  const pf = happyPreflight({ manifestText, journalDir: args.journalDir, now, root });
  if (!pf.checksPassed) return refuse(`PREFLIGHT_FAILED:${pf.blockers[0] ?? "UNKNOWN"}`, { stage: "preflight" });
  if (args.confirm !== pf.manifest.confirmToken) return refuse("CONFIRM_TOKEN_MISMATCH", { stage: "preflight" });

  // Only now: the owner's private credential entry.
  let creds;
  try { creds = await (deps.prompt ?? promptHostawayCredentials)(); } catch (e) {
    return { exitCode: EXIT.REFUSED, output: { ok: false, mode: "execute", stage: "credentials",
      error: typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "CREDENTIALS_UNAVAILABLE", network: "none" } };
  }
  const getCredentials = async () => { const c = creds; creds = null; return c; };   // handed over once

  let journal = null;
  try {
    journal = (deps.createJournal ?? createFileJournal)(resolve(args.journalDir), pf.manifest.hash);
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const transport = createHostawayTransport({ fetchImpl, getCredentials });
    const probe = createSideEffectProbe({ send: transport.send });
    const manifest = JSON.parse(manifestText);
    const report = await (deps.execute ?? executeHappyRun)({ mode: "execute", manifest, confirm: args.confirm, transport, journal,
      sideEffectProbe: probe.probe, now });
    const output = summarize(report, { ok: report.status === "COMPLETED", mode: "execute", reviewedCommit: args.reviewedCommit,
      journalFile: pf.journal.file, sideEffectReads: probe.usage().reads });
    return { exitCode: report.status === "COMPLETED" ? EXIT.COMPLETED : report.status === "HALTED" ? EXIT.HALTED : EXIT.REFUSED, output };
  } catch (e) {
    return { exitCode: EXIT.INTERNAL, output: { ok: false, mode: "execute", stage: "run",
      error: typeof e?.code === "string" && /^[A-Z_]{1,40}$/.test(e.code) ? e.code : "INTERNAL_ERROR" } };
  } finally {
    creds = null;
    if (journal && typeof journal.close === "function") { try { journal.close(); } catch { /* already closed */ } }
  }
}
