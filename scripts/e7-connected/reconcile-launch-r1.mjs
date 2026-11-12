// scripts/e7-connected/reconcile-launch-r1.mjs — E7 N2 reconcile-only runner (R-B, Step B): the LOCAL (owner WSL) wiring behind
// reconcile-cli-main.mjs. Imported ONLY after the CLI verified the reconcile execution closure digest. Design: claude/e7-g3/rb-stepB-launch-design-2026-11-12.md
// (ROOT: option L; D1 explicit ROOT-pinned recovery plan; D2/D6 trusted head ONLY from captured native stdout; D4 narrow reuse).
//   * Order: env evaluation (accepted) → namespace binding of BOTH run dirs (pure, then lstat: own uid, real dirs, no group/other bits, no
//     symlink; the reconcile run dir must NOT exist) → ROOT-pinned recovery plan (canonical bytes, sha256, identity vs both dirs / intent /
//     package) → the stopped native package re-bound at its HISTORICAL clock (accepted binder; read-only evidence, NO execution authority) →
//     HISTORICAL PROVENANCE of the native journal (below) → owner file ingress (accepted provider reader — Hostaway token used; the Stripe key is never used, accepted DB login
//     reader, CA) → accepted endpoint policy → accepted pool construction → REPORT + APP identity (accepted SQL_SAME_DB / checkSameDatabase) →
//     accepted Hostaway send (GET-only use is enforced by the reconcile executors) → ONE new exclusive reconcile run dir → the frozen
//     runReconcileR1 (PR62 9050b617) → bounded pool end (accepted endAll) → ONE sanitized result.
//   * HISTORICAL CLOCK (ROOT Step B boundary). plan.nativeExecClock is a ROOT-pinned binding clock, NOT a proof of the original execution time.
//     It is accepted only if: package.evaluatedAt ≤ nativeExecClock ≤ RUN_STARTED.at (first record of the TRUSTED native chain) ≤ … ≤ last.at ≤
//     now, records non-decreasing, and the accepted binder validates the package AT that clock. The run relationship itself is proven
//     independently: the chain is validated against the binding (manifestHash = packageHash, runId, intent), its tip must equal the
//     ROOT-pinned trusted head (from captured native stdout), and the frozen core re-reads the same chain with the accepted reader requiring
//     AT_ESCROW_HEAD + MATCH_TIP — the tip hash covers every record (incl. `at`), so both reads are tied to identical bytes. The native
//     package / journal / head are only READ (bounded O_NOFOLLOW); they never authorize create / abort / cleanup.
//   * Not used: runR1Launch / runPreflightR1 (they bind at NOW and call Stripe). Reconciliation makes ZERO Stripe calls and builds no Stripe
//     transport. ROOT F1: the owner's dual-key provider file IS read with the accepted reader (needs both, exact key set); the Stripe test key
//     stays a private capability that is never used, passed or output. The package's Stripe account is historical bound identity only.
//     Hostaway identity / auth is proven only by the allowed exact reservation GETs. The PI authorization margin is from DB facts (Stripe unobserved), as the core labels it.
//   * Nothing secret is placed in any result; owner values are passed only as capabilities. No retry / fallback / adopt / resume / repair.
import { createHash } from "node:crypto";
import { lstat as fspLstat, mkdir as fspMkdir, realpath as fspRealpath } from "node:fs/promises";
import path from "node:path";
import { runReconcileR1, validatePlanR1 } from "./reconcile-core-r1.mjs";
import { RUN_ID_RE } from "./reconcile-journal-r1.mjs";
import { bindRunPackageR1Journal, bindingKindV2, validateJournalBound, recordHashV2 } from "./run-journal-memory-v2.mjs";
import { journalFileNameR1 } from "./run-journal-file-v2.mjs";
import { canonicalJson } from "./run-manifest.mjs";
import { createE7HostawaySend } from "./http-transports.mjs";
import { createE7RealExchange } from "./real-exchange.mjs";
import { readProbeCredentialFile } from "./probe-credential-file.mjs";
import { readDbLoginFiles } from "./db-credential-file.mjs";
import { evaluateProbeEnvironment } from "./probe-env-preflight.mjs";
import { RUN_PLAN_CLOSURE, MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES, MAX_PLAN_BYTES } from "./run-plan-v1.mjs";
import { R1_EXECUTOR_CLOSURE, MAX_PACKAGE_BYTES } from "./run-binding-r1.mjs";
import { checkEndpointPolicy, endAll, MAX_CA_BYTES, POOL_MAX } from "./run-r1-launcher.mjs";
import { SQL_SAME_DB, checkSameDatabase } from "./run-preflight-r1.mjs";
import { createBookingPool } from "../../lib/booking-db/pool.js";

export const RECONCILE_LAUNCH_SCHEMA = "e7-reconcile-launch-result-v1";
export const PRIVATE_BASENAME = ".maravilla-private";
export const MAX_RECOVERY_PLAN_BYTES = 4096;
export const MAX_NATIVE_JOURNAL_BYTES = 4 * 1024 * 1024;
export const IDENTITY_QUERY_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;
const freeze = Object.freeze;

/** PURE: <P basename .maravilla-private>/runs/<runId> for both dirs, the same P, different run ids, P not inside the repo → null | code */
export function runDirsOk(nativeRunDir, reconcileRunDir, repoRoot) {
  const parts = (d) => { const runId = path.basename(d); const runs = path.dirname(d); const priv = path.dirname(runs); return { runId, runs, priv }; };
  const n = parts(nativeRunDir); const r = parts(reconcileRunDir);
  for (const x of [n, r]) if (path.basename(x.runs) !== "runs" || path.basename(x.priv) !== PRIVATE_BASENAME) return "RUN_DIR_NAMESPACE_INVALID";
  if (n.priv !== r.priv) return "RUN_DIR_NAMESPACE_INVALID";
  if (n.runId === r.runId || !RUN_ID_RE.test(r.runId)) return "RUN_DIR_NAMESPACE_INVALID";
  const rel = path.relative(repoRoot, n.priv);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return "RUN_DIR_INSIDE_REPO";
  return null;
}
/** lstat-based: a REAL directory (never a symlink), owned by uid, no group / other permission bits */
async function ownDir(p, uid) {
  try { const st = await fspLstat(p); return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0; } catch { return false; }
}
/** canonical: the resolved real path equals the literal path (no symlink anywhere in its ancestry) */
async function canonical(p) { try { return (await fspRealpath(p)) === p; } catch { return false; } }
async function absent(p) { try { await fspLstat(p); return false; } catch (e) { return !!e && e.code === "ENOENT"; } }

/** PURE: the ROOT-pinned recovery plan (canonical JSON bytes, no trailing newline) → { ok, plan } | { ok:false, code } */
export function decodeRecoveryPlan(b64, expectSha) {
  let bytes;
  try { bytes = Buffer.from(b64, "base64"); } catch { return freeze({ ok: false, code: "RECOVERY_PLAN_ENCODING" }); }
  if (bytes.length < 2 || bytes.length > MAX_RECOVERY_PLAN_BYTES || bytes.toString("base64") !== b64) return freeze({ ok: false, code: "RECOVERY_PLAN_ENCODING" });
  if (createHash("sha256").update(bytes).digest("hex") !== expectSha) return freeze({ ok: false, code: "RECOVERY_PLAN_HASH_MISMATCH" });
  let plan; try { plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return freeze({ ok: false, code: "RECOVERY_PLAN_INVALID" }); }
  if (plan === null || typeof plan !== "object" || Array.isArray(plan) || canonicalJson(plan) !== bytes.toString("utf8")) return freeze({ ok: false, code: "RECOVERY_PLAN_NOT_CANONICAL" });
  const pe = validatePlanR1(plan);
  if (pe) return freeze({ ok: false, code: pe });
  return freeze({ ok: true, plan });
}

/**
 * checkNativeProvenance({ bytes, binding, trustedHead, nativeExecClock, now }) → { ok:true, records, firstAt, lastAt } | { ok:false, code }
 * PURE over the bytes of the native R1 journal file (read once, bounded). See the HISTORICAL CLOCK note above.
 */
export function checkNativeProvenance({ bytes, binding, trustedHead, nativeExecClock, now }) {
  const no = (code) => freeze({ ok: false, code });
  let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return no("NATIVE_JOURNAL_INVALID"); }
  if (!text.endsWith("\n")) return no("NATIVE_JOURNAL_TORN");
  let recs; try { recs = text.slice(0, -1).split("\n").map((l) => JSON.parse(l)); } catch { return no("NATIVE_JOURNAL_INVALID"); }
  if (recs.length < 1) return no("NATIVE_JOURNAL_INVALID");
  const vj = validateJournalBound(recs, binding);
  if (!vj || vj.ok !== true) return no("NATIVE_JOURNAL_INVALID");
  if (recs.length !== trustedHead.seq || recordHashV2(recs.at(-1)) !== trustedHead.hash) return no("TRUSTED_HEAD_MISMATCH");
  if (recs[0].event !== "RUN_STARTED") return no("NATIVE_FIRST_NOT_RUN_STARTED");
  for (let i = 1; i < recs.length; i++) if (!(recs[i].at >= recs[i - 1].at)) return no("NATIVE_JOURNAL_CLOCK_NOT_MONOTONIC");
  if (!(nativeExecClock >= binding.r1.evaluatedAt)) return no("NATIVE_CLOCK_BEFORE_PACKAGE");
  if (!(nativeExecClock <= recs[0].at)) return no("NATIVE_CLOCK_AFTER_RUN_START");
  if (!(recs.at(-1).at <= now) || !(nativeExecClock <= now)) return no("NATIVE_JOURNAL_FUTURE");
  return freeze({ ok: true, records: recs.length, firstAt: recs[0].at, lastAt: recs.at(-1).at });
}

const bounded = (p, ms, proc) => new Promise((resolve) => {
  let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
  const id = proc.setTimer(() => fin({ done: false }), ms);
  Promise.resolve().then(() => p).then((value) => { proc.clearTimer(id); fin({ done: true, value }); }, () => { proc.clearTimer(id); fin({ done: true, threw: true }); });
});

/** the ONE sanitized result: whitelisted codes / counts / digests only (no URL, credential, guest, path, provider or error text) */
function sanitize(r, extra) {
  const run = r ? {
    outcome: r.outcome, code: r.code, runId: r.runId, intentId: r.intentId, steps: Array.isArray(r.steps) ? r.steps.length : null,
    stepStates: Array.isArray(r.steps) ? r.steps.map((s) => s.state) : null, gets: r.gets, getStatuses: Array.isArray(r.getLog) ? r.getLog.map((g) => g.httpStatus) : null,
    violations: Array.isArray(r.violations) ? r.violations.length : null, precheck: r.precheck ? { ok: r.precheck.ok === true, code: r.precheck.code ?? null } : null,
    final: r.final ? { ok: r.final.ok === true, code: r.final.code ?? null } : null, dbState: r.dbState, exclusionAfter: r.exclusionAfter, lock: r.lock,
    lockSession: r.lockSession ?? null, cleanup: r.cleanup, audit: r.audit, journalHead: r.journalHead ? { seq: r.journalHead.seq, hash: r.journalHead.hash } : null,
    elapsedMs: r.elapsedMs, liveEffects: r.liveEffects ?? null, queuedEffects: r.queuedEffects ?? null, dbEvidence: r.dbEvidence ?? null
  } : null;
  return JSON.parse(JSON.stringify({ schema: RECONCILE_LAUNCH_SCHEMA, run, ...extra }));
}
const refused = (stage, code, extra = {}) => freeze({ stage, code, result: sanitize(null, { refused: { stage, code }, ...extra }) });

/**
 * runReconcileLaunch({ flags, nat, proc, hooks, repoRoot, envSnapshot, interrupted }) → Promise<{ stage, code, result }>; never rejects.
 *   hooks (IN-PROCESS ONLY, never selectable from argv / env): { exchanges?: { hostaway }, loopbackEndpointsForTests?, core?: { monotonic, sleep },
 *   beforeStage?(stage) } — default: the real https exchange and ONLY the two exact DEV endpoints.
 *   interrupted(): true once the first SIGINT / SIGTERM arrived — checked at every stage boundary BEFORE the core; `signal` (aborted by the
 *   same first signal) is passed INTO the core (PR63 S1): no new GET / step / success after it → STOPPED / INTERRUPTED.
 */
export async function runReconcileLaunch(input) {
  const { flags, nat, proc, hooks, repoRoot } = input;
  const interrupted = typeof input.interrupted === "function" ? input.interrupted : () => false;
  const stage = async (s) => { if (hooks && typeof hooks.beforeStage === "function") await hooks.beforeStage(s); return interrupted(); };
  let uid; try { uid = proc.getuid(); } catch { return refused("boot", "UID_UNAVAILABLE"); }
  // ---- (1) accepted env evaluation ----------------------------------------------------------------------------------------------------
  const env = evaluateProbeEnvironment(input.envSnapshot);
  if (!env.ok) return refused("env", env.code);
  // ---- (2) namespace binding of both run dirs --------------------------------------------------------------------------------------------
  if (await stage("namespace")) return refused("namespace", "INTERRUPTED");
  const nsCode = runDirsOk(flags.nativeRunDir, flags.reconcileRunDir, repoRoot);
  if (nsCode) return refused("namespace", nsCode);
  const priv = path.dirname(path.dirname(flags.nativeRunDir));
  const nativeId = path.basename(flags.nativeRunDir);
  const dirs = { package: `${flags.nativeRunDir}/package`, journal: `${flags.nativeRunDir}/journal`, head: `${flags.nativeRunDir}/head` };
  // PR63 N1: EVERY namespace dir must be canonical (realpath === path: no symlinked ancestor anywhere) AND an own-uid private real dir;
  // the repo exclusion is re-checked on the RESOLVED repo root. No chmod / repair / adopt.
  for (const d of [priv, path.dirname(flags.nativeRunDir), flags.nativeRunDir, dirs.package, dirs.journal, dirs.head]) {
    if (!(await canonical(d))) return refused("namespace", "RUN_DIR_NOT_CANONICAL");
    if (!(await ownDir(d, uid))) return refused("namespace", "RUN_DIR_UNSAFE");
  }
  let realRepo; try { realRepo = await fspRealpath(repoRoot); } catch { return refused("namespace", "REPO_ROOT_UNRESOLVED"); }
  if (runDirsOk(flags.nativeRunDir, flags.reconcileRunDir, realRepo)) return refused("namespace", "RUN_DIR_INSIDE_REPO");
  if (!(await absent(flags.reconcileRunDir))) return refused("namespace", "RECONCILE_RUN_DIR_EXISTS");
  // ---- (3) ROOT-pinned recovery plan -----------------------------------------------------------------------------------------------------
  if (await stage("plan")) return refused("plan", "INTERRUPTED");
  const dp = decodeRecoveryPlan(flags.recoveryPlanB64, flags.expectRecoveryPlanSha256);
  if (!dp.ok) return refused("plan", dp.code);
  const plan = dp.plan;
  if (plan.runId !== path.basename(flags.reconcileRunDir) || plan.nativeRunId !== nativeId) return refused("plan", "PLAN_RUN_ID_MISMATCH");
  if (plan.intentId !== flags.intent) return refused("plan", "PLAN_INTENT_MISMATCH");
  if (plan.nativePackageHash !== flags.expectNativePackageHash) return refused("plan", "PLAN_PACKAGE_MISMATCH");
  // ---- (4) the stopped native package, re-bound at its HISTORICAL clock (accepted binder) ------------------------------------------------
  if (await stage("package")) return refused("package", "INTERRUPTED");
  let packageBytes; let planBytes; let foundationSources; let executorSources;
  try {
    packageBytes = await nat.readBounded(`${dirs.package}/package.json`, MAX_PACKAGE_BYTES);
    planBytes = await nat.readBounded(`${dirs.package}/plan.json`, MAX_PLAN_BYTES);
    const readList = async (list) => { const out = []; let t = 0; for (const p of list) { const b = await nat.readBounded(`${repoRoot}/${p}`, MAX_SOURCE_FILE_BYTES); t += b.length; if (t > MAX_SOURCE_TOTAL_BYTES) throw new Error("e7"); out.push({ path: p, bytes: b }); } return out; };
    foundationSources = await readList(RUN_PLAN_CLOSURE); executorSources = await readList(R1_EXECUTOR_CLOSURE);
  } catch { return refused("package", "PACKAGE_READ_FAILED"); }
  const r1 = { packageBytes, planBytes, foundationSources, executorSources, envSnapshot: input.envSnapshot,
    expected: { packageHash: flags.expectNativePackageHash, executorDigest: flags.expectExecutorDigest } };
  const nb = bindRunPackageR1Journal(r1, plan.nativeExecClock);
  if (!nb.ok) return refused("package", nb.binderCode || nb.code);
  const B = nb.binding;
  if (bindingKindV2(B) !== "r1") return refused("package", "BINDING_UNVERIFIED");
  if (B.identity.runId !== nativeId || B.identity.intentId !== flags.intent || B.manifest.intentId !== flags.intent) return refused("package", "PACKAGE_IDENTITY_MISMATCH");
  if (B.r1.paymentIntentId !== plan.paymentIntentId) return refused("package", "PACKAGE_PI_MISMATCH");
  // PR63 P1: EVERY shared original scope field of the ROOT-pinned recovery plan must equal the VERIFIED native package (deliberate map).
  // version / createOpId / attemptId / reservationId are NOT package fields: separately pinned and checked by the core's preflight under its lock.
  // Account / DB identity stays the package's historical bound scope (never replaced by DB facts); the amount covers the bound quote total.
  const M = B.manifest;
  const scope = [["ref", plan.ref, M.expectedRef], ["listingId", plan.listingId, M.listing.id], ["currency", plan.currency, M.listing.currency],
    ["refFieldId", plan.refFieldId, M.listing.refFieldId], ["from", plan.from, M.stay.arrival], ["to", plan.to, M.stay.departure],
    ["guests", plan.guests, M.stay.guests], ["totalMinor", plan.totalMinor, M.amountMinor], ["rateBps", plan.rateBps, M.pricing.rateBps],
    ["intentId", plan.intentId, M.intentId], ["facts.listingId", plan.listingId, B.facts.listingId], ["facts.amountMinor", plan.totalMinor, B.facts.amountMinor]];
  for (const [k, a, b] of scope) if (a !== b) return refused("package", "PACKAGE_SCOPE_MISMATCH", { field: k });
  // ---- (5) historical provenance of the native journal (read once, bounded, read-only) -----------------------------------------------
  if (await stage("provenance")) return refused("provenance", "INTERRUPTED");
  const [seqS, hash] = flags.expectTrustedHead.split(":");
  const trustedHead = freeze({ seq: Number(seqS), hash });
  if (!Number.isSafeInteger(trustedHead.seq) || trustedHead.seq < 1 || !HEX64.test(hash)) return refused("provenance", "TRUSTED_HEAD_INVALID");
  let jbytes;
  try { jbytes = await nat.readBounded(`${dirs.journal}/${journalFileNameR1(nativeId)}`, MAX_NATIVE_JOURNAL_BYTES); } catch { return refused("provenance", "NATIVE_JOURNAL_UNREADABLE"); }
  const pv = checkNativeProvenance({ bytes: jbytes, binding: B, trustedHead, nativeExecClock: plan.nativeExecClock, now: proc.now() });
  if (!pv.ok) return refused("provenance", pv.code);
  const provenance = { records: pv.records, firstAt: pv.firstAt, lastAt: pv.lastAt, trustedHead: { seq: trustedHead.seq, hash: trustedHead.hash }, historicalClock: plan.nativeExecClock };
  // ---- (6) owner file ingress: dual-key provider file (Hostaway token used; Stripe key read, never used), DB logins, endpoint policy, CA ------------------------------------
  if (await stage("owner-files")) return refused("owner-files", "INTERRUPTED", { provenance });
  // The accepted reader requires the file's EXACT key set; the owner's existing provider file holds BOTH keys (native run), so it is read with
  // both needs. The Stripe test key stays a non-enumerable capability that is NEVER passed to any transport / result (no Stripe transport
  // exists in this path). ROOT decision point: a Hostaway-only owner file would avoid even holding it, at the cost of a new owner file.
  const pc = await readProbeCredentialFile({ path: flags.providerCredentials, repoRoot, needs: { hostaway: true, stripe: true }, fs: nat.credentialFs });
  if (!pc.ok) return refused("provider-credentials", pc.code, { provenance });
  const db = await readDbLoginFiles({ appPath: flags.dbApp, reportPath: flags.dbReport, repoRoot, fs: nat.credentialFs });
  if (!db.ok) return refused(`db-login-${db.slot ?? "pair"}`, db.code, { provenance });
  const ep = checkEndpointPolicy(db.logins, { loopbackForTests: !!(hooks && hooks.loopbackEndpointsForTests === true) });
  if (!ep.ok) return refused("db-endpoint", ep.code, { provenance });
  let caPem = null;
  if (flags.dbCa !== "none") {
    try {
      const b = await nat.readBounded(flags.dbCa, MAX_CA_BYTES);
      caPem = new TextDecoder("utf-8", { fatal: true }).decode(b);
      if (!/^-----BEGIN CERTIFICATE-----\r?\n[\s\S]+-----END CERTIFICATE-----\s*$/.test(caPem)) return refused("db-ca", "CA_NOT_PEM", { provenance });
    } catch { return refused("db-ca", "CA_READ_FAILED", { provenance }); }
  }
  // ---- (7) pools (accepted construction) + REPORT / APP identity (accepted SQL_SAME_DB / checkSameDatabase) ----------------------------
  const pools = {};
  try { for (const slot of ["app", "report"]) pools[slot] = createBookingPool({ connectionString: db.logins[slot].connectionString, caPem, max: POOL_MAX[slot] }); }
  catch { for (const p of Object.values(pools)) p.end().catch(() => {}); return refused("pool", "POOL_CONFIG_REFUSED", { provenance }); }
  for (const p of Object.values(pools)) p.on("error", () => {});                                   // idle-client errors: contained, never echoed
  const endPools = () => endAll(pools, proc, null, null);
  const fail = async (st, code) => { const pe = await endPools(); return refused(st, code, { provenance, teardown: { pools: pe } }); };
  if (await stage("db-identity")) return fail("db-identity", "INTERRUPTED");
  const rq = await bounded(pools.report.query(SQL_SAME_DB), IDENTITY_QUERY_MS, proc);
  const aq = await bounded(pools.app.query(SQL_SAME_DB), IDENTITY_QUERY_MS, proc);
  if (!rq.done || rq.threw || !aq.done || aq.threw) return fail("db-identity", "DB_IDENTITY_UNREADABLE");
  const same = checkSameDatabase(rq.value.rows, aq.value.rows);
  if (!same.ok) return fail("db-identity", same.code);
  // ---- (8) the accepted Hostaway send (the reconcile executors restrict it to exact GETs) ----------------------------------------------
  const creds = pc.credentials;
  const xh = hooks && hooks.exchanges ? { ok: true, exchange: hooks.exchanges.hostaway } : createE7RealExchange({ provider: "hostaway" });
  const th = xh.ok ? createE7HostawaySend({ exchange: xh.exchange, credential: () => creds.hostawayToken }) : xh;
  if (!th.ok) return fail("transport", "TRANSPORT_OPTIONS_INVALID");
  // ---- (9) ONE new exclusive reconcile run dir + journal dir ------------------------------------------------------------------------------
  if (await stage("reconcile-dir")) return fail("reconcile-dir", "INTERRUPTED");
  const jdir = `${flags.reconcileRunDir}/journal`;
  try { await fspMkdir(flags.reconcileRunDir, { mode: 0o700 }); await fspMkdir(jdir, { mode: 0o700 }); } catch { return fail("reconcile-dir", "RECONCILE_DIR_CREATE_FAILED_LEFT_IN_PLACE"); }
  if (!(await ownDir(flags.reconcileRunDir, uid)) || !(await ownDir(jdir, uid))) return fail("reconcile-dir", "RECONCILE_DIR_UNSAFE_LEFT_IN_PLACE");
  // ---- (10) the frozen reconcile core ---------------------------------------------------------------------------------------------------
  if (await stage("run")) return fail("run", "INTERRUPTED");
  let r = null;
  try {
    r = await runReconcileR1({ plan, pools: { app: pools.app, report: pools.report }, hostawaySend: th.transport.send, clock: () => proc.now(),
      monotonic: hooks && hooks.core && hooks.core.monotonic ? hooks.core.monotonic : () => proc.monotonic(), ...(hooks && hooks.core && hooks.core.sleep ? { sleep: hooks.core.sleep } : {}),
      journalDir: jdir, uid, native: { packageInput: r1, journalDir: dirs.journal, headDir: dirs.head, trustedHead },
      ...(input.signal instanceof AbortSignal ? { signal: input.signal } : {}) });
  } catch { r = null; }
  const pe = await endPools();
  const code = r === null ? "CORE_FAILED" : r.outcome;
  return freeze({ stage: "run", code, result: sanitize(r, { provenance, teardown: { pools: pe }, interrupted: interrupted() }) });
}
