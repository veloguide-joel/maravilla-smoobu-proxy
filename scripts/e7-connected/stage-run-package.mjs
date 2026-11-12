// scripts/e7-connected/stage-run-package.mjs — E7 G3b: LOCAL package staging (replaces the long base64 paste of the r2 placement block).
//   * Owner-run, no stdin: every input is a bounded NON-SECRET argv value (ONE compact base64 fact JSON + run id + reviewed pins).
//     It never reads stdin, credentials, env values, DB, provider or network. It imports only pure accepted modules + node built-ins.
//   * It derives the EXACT canonical plan (the r2 builder's fixed scope + ROOT-reviewed timestamp mapping) and the EXACT canonical package
//     (accepted buildRunPackageV1 over the accepted RUN_PLAN_CLOSURE bytes of THIS checkout) with the caller-pinned createdAt / evaluatedAt,
//     so ROOT can precompute and pin --expect-plan-sha256 / --expect-package-hash BEFORE the owner runs it. Any mismatch → refuse, no write.
//   * Before any write it runs the accepted pure R1 binder (bindRunPackageR1) at the local clock with the reviewed executor digest → R1_OK
//     is required (so the later native launch binds the same bytes unless the clock passes the quote cap).
//   * Destination NAMESPACE BINDING (rev2, ROOT F1): --package-dir must be exactly <private>/runs/<runId>/package with <private> basename
//     ".maravilla-private" and NOT inside this repository; journal / head / any other dir is refused before any I/O. The 4 dirs are then
//     real, canonical, own-uid, mode 0700, and the package dir readable + EMPTY.
//   * Writes exactly two files: O_CREAT|O_EXCL|O_NOFOLLOW requested 0600; the NEW fd must then fstat as a regular own-uid nlink-1 file with
//     mode EXACTLY 0600 (rev2, ROOT F2: an inherited restrictive umask is refused, never chmod-repaired) BEFORE any byte is written. No
//     overwrite / chmod / repair / adopt / cleanup / retry: after the first create, every failure is *_LEFT_IN_PLACE.
//   * Baseline note: FIXED.repoCommit is the reviewed EXECUTION baseline the plan declares (4559cbda: PR #72 recording-worker outer stop safety,
//     diagnostic token COMPLETED:EVENT_DEFERRED per ROOT 5883244600, on the PR #67 0019 test-cleanup foundation / lease-maintenance baseline;
//     ROOT behavioural PASS 5883156810); it is NOT a claim about the
//     current Git HEAD of the checkout this helper is published in. The foundation sourceDigest is what binds the actual bytes.
//   * NOT part of any reviewed closure (native / foundation / executor lists unchanged); no execute mode.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./run-manifest.mjs";
import { CHECKPOINTS_BY_CONNECTION } from "./run-manifest-v2.mjs";
import { ALLOWED_OPS, HISTORICAL_EXCLUSIONS, RUN_PLAN_CLOSURE, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES, buildRunPackageV1, validateRunPlanV1 } from "./run-plan-v1.mjs";
import { bindRunPackageR1, R1_EXECUTOR_CLOSURE } from "./run-binding-r1.mjs";
import { evaluateProbeEnvironment, PRESENT_KEYS } from "./probe-env-preflight.mjs";

export const STAGE_SCHEMA = "e7-stage-run-package-v1";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FACTS_SCHEMA = "e7-g3b-intent-facts-v2";
export const REQUIRED_NODE = "v22.22.0";
export const MAX_FACTS_B64 = 4096;
export const MAX_FACTS_JSON = 3072;
export const FIXED = Object.freeze({
  // PR #67 (0019 test-cleanup foundation) extends intent-state / repo / operations; PR #72 (recording-worker outer signal / deadline stop
  // safety) extends recording-worker.js in the reviewed foundation. Future packages bind those reviewed bytes; existing (spent) packages are
  // never rewritten.
  repoCommit: "4559cbdaa49227a0bd9f89228e968205b70c6ebd", sourceDigest: "4d7963e83d72bfa42785975affa79be4b63f188f71aa525fa1578ef63fdcbd7a",
  stripeAccountId: "acct_1TyHE42B9LTneQgw", hostawayAccountRef: "201434", clientSnapshotId: "provider-file-h1-20261111",
  listing: Object.freeze({ id: 606998, currency: "USD", refFieldId: 105433, timeZone: "America/Mexico_City", connection: "disconnected" }),
  deadlines: Object.freeze({ quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 1 }), stayRules: Object.freeze({ minLeadDays: 7, maxNights: 1 }) });
export const FLAGS = Object.freeze({ "--run-id": "runId", "--package-dir": "path", "--facts-b64": "b64", "--created-at": "iso", "--evaluated-at": "iso",
  "--expect-plan-sha256": "hex", "--expect-package-hash": "hex", "--expect-executor-digest": "hex" });
const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const freeze = Object.freeze;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const isoMs = (s) => { if (typeof s !== "string" || !ISO_RE.test(s)) return null; const t = Date.parse(s); return Number.isFinite(t) && new Date(t).toISOString() === s ? t : null; };
const canonicalPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 4096 && p[0] === "/" && !p.includes("\0")
  && p.slice(1).split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** parseArgs(tokens) → frozen flags | null (each flag exactly once, typed) */
export function parseArgs(tokens) {
  const keys = Object.keys(FLAGS);
  if (!Array.isArray(tokens) || tokens.length !== 2 * keys.length) return null;
  const f = {};
  for (let i = 0; i < tokens.length; i += 2) {
    const k = tokens[i]; const v = tokens[i + 1];
    if (typeof k !== "string" || typeof v !== "string" || !Object.hasOwn(FLAGS, k)) return null;
    const name = k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(f, name)) return null;
    const t = FLAGS[k];
    const ok = t === "runId" ? RUN_ID_RE.test(v) : t === "path" ? canonicalPath(v) : t === "b64" ? v.length <= MAX_FACTS_B64 && B64_RE.test(v)
      : t === "iso" ? isoMs(v) !== null : t === "hex" ? HEX64.test(v) : false;
    if (!ok) return null;
    f[name] = v;
  }
  return freeze(f);
}

/** decodeFacts(b64) → facts object | { error } (exact v2 shape: matched 1, the reviewed fact keys) */
export function decodeFacts(b64) {
  let raw;
  try { const buf = Buffer.from(b64, "base64"); if (buf.length < 2 || buf.length > MAX_FACTS_JSON || buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) return { error: "FACTS_B64_INVALID" }; raw = JSON.parse(buf.toString("utf8")); }
  catch { return { error: "FACTS_JSON_INVALID" }; }
  if (!raw || typeof raw !== "object" || raw.schema !== FACTS_SCHEMA || raw.matched !== 1 || !raw.facts || typeof raw.facts !== "object") return { error: "FACTS_NOT_EXACTLY_ONE" };
  return { facts: raw.facts };
}

/** planFromFacts(facts, runId, createdAt) → { plan } | { error } — the r2 builder's fixed scope + reviewed mapping, no substitution */
export function planFromFacts(f, runId, createdAt) {
  const need = ["intentId", "expectedRef", "arrival", "departure", "guests", "amountMinor", "currency", "rateBps", "paymentIntentId", "listingId", "environment",
    "state", "livemode", "authorizedMinor", "reservationId", "priceConfirmedTransitions", "priceConfirmedAt", "authorizationCreatedAt", "authorizationAcceptedAt",
    "firstPaymentAuthorizedTransitionAt"];
  for (const k of need) if (!Object.hasOwn(f, k)) return { error: "FACT_MISSING" };
  if (f.listingId !== FIXED.listing.id || f.currency !== FIXED.listing.currency || f.environment !== "test" || f.state !== "payment_authorized" || f.livemode !== false)
    return { error: "FACT_SCOPE" };
  if (f.reservationId !== null || f.authorizedMinor !== f.amountMinor) return { error: "FACT_STATE" };
  if (!Number.isSafeInteger(f.rateBps) || f.rateBps < 0 || f.rateBps > 5000) return { error: "RATE_OVER_BINDER_CAP" };
  if (f.priceConfirmedTransitions !== 1) return { error: "PRICE_CONFIRMED_NOT_EXACTLY_ONE" };
  const tq = isoMs(f.priceConfirmedAt), ta = isoMs(f.authorizationCreatedAt), tacc = isoMs(f.authorizationAcceptedAt), tpa = isoMs(f.firstPaymentAuthorizedTransitionAt);
  if ([tq, ta, tacc, tpa].some((x) => x === null)) return { error: "TIMESTAMP_MISSING" };
  if (!(tq <= ta)) return { error: "PROVIDER_AUTH_BEFORE_QUOTE" };
  if (!(ta <= tacc && ta <= tpa)) return { error: "LOCAL_ACCEPTANCE_BEFORE_PROVIDER_AUTH" };
  const plan = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId, createdAt,
    baseline: { repoCommit: FIXED.repoCommit, sourceDigest: FIXED.sourceDigest },
    environment: { stripe: { mode: "test", accountId: FIXED.stripeAccountId }, hostaway: { accountRef: FIXED.hostawayAccountRef, clientSnapshotId: FIXED.clientSnapshotId },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { ...FIXED.listing }, phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: [...CHECKPOINTS_BY_CONNECTION[FIXED.listing.connection]], deadlines: { ...FIXED.deadlines }, stayRules: { ...FIXED.stayRules },
    exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)),
    binding: { intentId: f.intentId, expectedRef: f.expectedRef, stay: { arrival: f.arrival, departure: f.departure, guests: f.guests }, amountMinor: f.amountMinor,
      quote: { totalMinor: f.amountMinor, currency: "USD", quotedAt: f.priceConfirmedAt }, rateBps: f.rateBps, paymentIntentId: f.paymentIntentId, authorizedAt: f.authorizationCreatedAt } };
  return { plan };
}

/** precheck({ flags, envSnapshot, now }) → { ok:true, facts, plan } | { ok:false, code }: env / node / destination / facts / plan pin / clock,
 *  ALL before any source or filesystem I/O (rev2 order). PURE. */
export function precheck({ flags, envSnapshot, now }) {
  const R = (code) => freeze({ ok: false, code });
  const env = evaluateProbeEnvironment(envSnapshot); if (!env.ok) return R(`ENV_${env.code}`);
  if (envSnapshot.nodeVersion !== REQUIRED_NODE.slice(1)) return R("NODE_NOT_22_22_0");
  const dest = destinationOk(flags.packageDir, flags.runId); if (dest) return R(dest);
  const df = decodeFacts(flags.factsB64); if (df.error) return R(df.error);
  const createdMs = isoMs(flags.createdAt); const evalMs = isoMs(flags.evaluatedAt);
  if (!(createdMs <= evalMs)) return R("CREATED_AFTER_EVALUATED");
  if (!Number.isSafeInteger(now) || now < evalMs) return R("CLOCK_BEHIND_EVALUATED_AT");
  const pf = planFromFacts(df.facts, flags.runId, flags.createdAt); if (pf.error) return R(pf.error);
  const planBytes = Buffer.from(`${canonicalJson(pf.plan)}\n`, "utf8");
  if (sha(planBytes) !== flags.expectPlanSha256) return R("PLAN_SHA_MISMATCH");
  const atNow = validateRunPlanV1(pf.plan, { planClock: now }); if (!atNow.ok || !atNow.bound) return R(`PLAN_${atNow.code || "UNBOUND"}`);
  return freeze({ ok: true, facts: df.facts, plan: pf.plan, planBytes, evalMs });
}
/** destinationOk(packageDir, runId) → null | code. PURE path binding: <private ".maravilla-private">/runs/<runId>/package, outside the repo. */
export const PRIVATE_BASENAME = ".maravilla-private";
export function destinationOk(pkgDir, runId, repoRoot = REPO_ROOT) {
  if (!canonicalPath(pkgDir)) return "DESTINATION_INVALID";
  const run = path.dirname(pkgDir); const runs = path.dirname(run); const priv = path.dirname(runs);
  if (path.basename(pkgDir) !== "package") return "DESTINATION_NOT_PACKAGE";
  if (path.basename(run) !== runId) return "DESTINATION_RUN_ID_MISMATCH";
  if (path.basename(runs) !== "runs" || path.basename(priv) !== PRIVATE_BASENAME) return "DESTINATION_NAMESPACE_INVALID";
  if (pkgDir === repoRoot || pkgDir.startsWith(`${repoRoot}/`) || pkgDir.split("/").includes(".git")) return "DESTINATION_IN_REPO";
  return null;
}

/**
 * buildStaged({ flags, envSnapshot, now, foundationSources, executorSources }) → { ok:true, planBytes, packageBytes, planSha256, packageSha256, packageHash }
 * | { ok:false, code }. PURE (no fs / clock / process): the CLI and the reviewer's precompute share it.
 */
export function buildStaged({ flags, envSnapshot, now, foundationSources, executorSources }) {
  const R = (code) => freeze({ ok: false, code });
  const pc = precheck({ flags, envSnapshot, now }); if (!pc.ok) return pc;
  const df = { facts: pc.facts }; const planBytes = pc.planBytes; const evalMs = pc.evalMs;
  const built = buildRunPackageV1({ planBytes: new Uint8Array(planBytes), sourceEntries: foundationSources, envSnapshot, planClock: evalMs });
  if (!built.ok) return R(`BUILD_${built.code}`);
  const packageBytes = Buffer.from(`${canonicalJson(built.package)}\n`, "utf8");
  if (built.packageHash !== flags.expectPackageHash) return R("PACKAGE_HASH_MISMATCH");
  const b = bindRunPackageR1({ envSnapshot, execClock: now, executorSources, expected: { executorDigest: flags.expectExecutorDigest, packageHash: flags.expectPackageHash },
    foundationSources, packageBytes: new Uint8Array(packageBytes), planBytes: new Uint8Array(planBytes) });
  if (!b.ok) return R(`BINDER_${b.code}`);
  if (b.binding.scope.intentId !== df.facts.intentId) return R("BINDER_SCOPE");
  return freeze({ ok: true, planBytes, packageBytes, planSha256: sha(planBytes), packageSha256: sha(packageBytes), packageHash: built.packageHash });
}

// ---- native I/O (CLI only) ----------------------------------------------------------------------------------------------------------
const C = fs.constants;
function readBounded(p, max) {
  const fd = fs.openSync(p, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd); if (!st.isFile() || st.size > max) throw new Error("e7");
    const buf = Buffer.alloc(st.size + 1); let off = 0;
    for (;;) { const n = fs.readSync(fd, buf, off, buf.length - off, null); if (n === 0) break; off += n; if (off > st.size) throw new Error("e7"); }
    if (off !== st.size) throw new Error("e7");
    return new Uint8Array(buf.subarray(0, off));
  } finally { fs.closeSync(fd); }
}
export function readClosure(root, list) {
  const out = []; let total = 0;
  for (const rel of list) { const bytes = readBounded(`${root}/${rel}`, MAX_SOURCE_FILE_BYTES); total += bytes.length; if (total > MAX_SOURCE_TOTAL_BYTES) throw new Error("e7"); out.push({ path: rel, bytes }); }
  return out;
}
/** the package dir + its 3 ancestors: real dir, not a symlink, canonical realpath, own uid, mode 0700 */
export function checkDirs(pkgDir, uid) {
  const dirs = [pkgDir, path.dirname(pkgDir), path.dirname(path.dirname(pkgDir)), path.dirname(path.dirname(path.dirname(pkgDir)))];
  for (const d of dirs) {
    let st; try { st = fs.lstatSync(d); } catch { return "DIR_INVALID"; }
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o700) return "DIR_INVALID";
    let rp; try { rp = fs.realpathSync(d); } catch { return "DIR_INVALID"; }
    if (rp !== d) return "DIR_INVALID";
  }
  let names; try { names = fs.readdirSync(pkgDir); } catch { return "PACKAGE_DIR_READ_FAILED"; }
  return names.length === 0 ? null : "PACKAGE_DIR_NOT_EMPTY";
}
/** writeExclusive(p, bytes, uid, io=fs) → null | code. Create-exclusive; the NEW fd must be a regular own-uid nlink-1 file of mode EXACTLY 0600
 *  before any byte is written (umask refusal, no chmod); a write that makes no progress is a fixed failure (no loop, no retry, no timer). */
export function writeExclusive(p, bytes, uid, io = fs) {
  let fd;
  try { fd = io.openSync(p, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600); } catch { return "CREATE_FAILED"; }
  try {
    let st; try { st = io.fstatSync(fd); } catch { return "FSTAT_FAILED_LEFT_IN_PLACE"; }
    if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600) return "MODE_UNSUPPORTED_LEFT_IN_PLACE";
    let off = 0;
    while (off < bytes.length) {
      let n; try { n = io.writeSync(fd, bytes, off, bytes.length - off); } catch { return "WRITE_FAILED_LEFT_IN_PLACE"; }
      if (!Number.isSafeInteger(n) || n <= 0 || n > bytes.length - off) return "WRITE_NO_PROGRESS_LEFT_IN_PLACE";
      off += n;
    }
    try { io.fsyncSync(fd); } catch { return "FSYNC_FAILED_LEFT_IN_PLACE"; }
    return null;
  } finally { try { io.closeSync(fd); } catch { /* contained */ } }
}

export function main(proc) {
  const emit = (obj, code) => { proc.stdout.write(`${JSON.stringify({ schema: STAGE_SCHEMA, ...obj })}\n`); proc.exitCode = code; };
  const flags = parseArgs(proc.argv.slice(2)); if (!flags) return emit({ code: "USAGE" }, 2);
  if (proc.version !== REQUIRED_NODE) return emit({ code: "NODE_NOT_22_22_0" }, 3);
  if (proc.platform !== "linux" && proc.platform !== "darwin") return emit({ code: "PLATFORM_UNSUPPORTED" }, 3);
  let uid = null; try { uid = proc.getuid(); } catch { uid = null; }
  if (!Number.isSafeInteger(uid)) return emit({ code: "UID_UNAVAILABLE" }, 3);
  const env = proc.env;
  const envSnapshot = freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: proc.version.slice(1), platform: proc.platform, execArgvCount: proc.execArgv.length,
    uidAvailable: true, present: freeze(Object.fromEntries(PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]))) });
  const now = Date.now();
  const pre = precheck({ flags, envSnapshot, now }); if (!pre.ok) return emit({ code: pre.code }, 4);   // env/node/destination/facts/clock BEFORE source I/O
  const root = REPO_ROOT;
  let foundationSources; let executorSources;
  try { foundationSources = readClosure(root, RUN_PLAN_CLOSURE); executorSources = readClosure(root, R1_EXECUTOR_CLOSURE); }
  catch { return emit({ code: "SOURCE_READ_FAILED" }, 4); }
  const s = buildStaged({ flags, envSnapshot, now, foundationSources, executorSources });
  if (!s.ok) return emit({ code: s.code }, 4);
  const dc = checkDirs(flags.packageDir, uid); if (dc) return emit({ code: dc }, 4);
  // ---- writes: from here every failure is LEFT_IN_PLACE (no unlink / overwrite / retry) ----
  const planPath = `${flags.packageDir}/plan.json`; const pkgPath = `${flags.packageDir}/package.json`;
  const w1 = writeExclusive(planPath, s.planBytes, uid); if (w1) return emit({ code: `PLAN_${w1}` }, 5);
  const w2 = writeExclusive(pkgPath, s.packageBytes, uid); if (w2) return emit({ code: `PACKAGE_${w2}`.endsWith("_LEFT_IN_PLACE") ? `PACKAGE_${w2}` : `PACKAGE_${w2}_PLAN_LEFT_IN_PLACE` }, 5);
  try {
    if (sha(readBounded(planPath, 65536)) !== s.planSha256) return emit({ code: "PLAN_READBACK_MISMATCH_LEFT_IN_PLACE" }, 5);
    if (sha(readBounded(pkgPath, 65536)) !== s.packageSha256) return emit({ code: "PACKAGE_READBACK_MISMATCH_LEFT_IN_PLACE" }, 5);
  } catch { return emit({ code: "READBACK_FAILED_LEFT_IN_PLACE" }, 5); }
  return emit({ code: "PACKAGE_STAGED", runId: flags.runId, planSha256: s.planSha256, packageSha256: s.packageSha256, packageHash: s.packageHash }, 0);
}

if (import.meta.main === true) main(process);
