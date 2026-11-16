// scripts/e7-hosted-kickoff.mjs — Stage E7 C111: HOSTED KICKOFF runner (SHIPPED CLOSED).
//
// ONE bounded invocation of the ACCEPTED C108 kickoff CONSUMER (lib/booking-db/pipeline-kickoff.js) with the C110 GitHub workflow_dispatch
// TRANSPORT (lib/booking-db/pipeline-dispatch-transport.js) for ONE explicitly bound durable 0024 request (booking.pipeline_kickoff_requests).
// A successful run hands ONE request's stored inputs to `.github/workflows/e7-hosted-pipeline.yml` on main; it does NOT execute the pipeline,
// does NOT complete a booking, does NOT touch Stripe / Hostaway, and `dispatch_accepted` (HTTP 204) is NOT a booking. That pipeline run still
// waits for the normal `e7-readonly-probe` reviewer gate and performs its own fresh proofs.
//
// SHIPPED CLOSED: CONSTANTS.executeEnabled and CONSTANTS.dispatchEnabled are FALSE. `verify` and `execute` refuse HKO_EXECUTE_CLOSED from KEY
// NAMES only — before any environment VALUE, tooling import, credential, database or network. Even with executeEnabled open, the core refuses
// HKO_DISPATCH_CLOSED before any DB acquisition while dispatchEnabled is false.
//
// RELEASE BINDING (C111 circular pinning): the transport is NOT loosened to "any main". The ONLY expectedMainSha it receives is this run's own
// `github.sha` (E7_WORKFLOW_SHA == the wrapper checkout HEAD), passed at CONSTRUCTION as a reviewed release binding (never call / guest input),
// and only AFTER this runner proved — before any secret — that the SAME checkout's pipeline runnerFiles frame to the reviewed ENABLE source
// digest f09bcbbd…0999 and that the pipeline's pinned closure is f7d7cad6…7273. GET refs/heads/main must then equal that sha (main has not moved),
// otherwise the transport returns notSent and 0 POST happens. Wrong / closed / stale pipeline source or a foreign HEAD → 0 credential read, 0 POST.
//
// SUPERVISION (the C91 pattern, re-implemented here; the pipeline runner is not edited): ONE seal (wall deadline / run abort / a local connect or
// statement timeout) ends ALL DB and dispatch admission at once — every tracked client is destroyed, late clients are destroyed unused, late
// statements are refused, the guarded exchange refuses any GET / POST after the seal, and a late consumer result is DISCARDED (never upgraded).
// In-flight claim / COMMIT at the seal → 0 dispatch (human-owned). A possibly started POST → UNKNOWN, never upgraded by a late 204.
// The DB session is the runtime app role over TLS with the pinned CA (never the owner / admin role); ONE consumer invocation for ONE bound
// request (never a queue sweep, never an auto-resume). UNKNOWN / claimed uncertainty is human-owned: no retry, recovery or repair.
//
// The ONLY top-level effect is the guarded main() at the bottom. No schedule / cron / webhook / route triggers this file (dispatch only).
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const freeze = Object.freeze;
const deepFreeze = (o) => { if (o && typeof o === "object") { for (const v of Object.values(o)) deepFreeze(v); freeze(o); } return o; };

export const CATALOG_PINS = deepFreeze({                         // derived from the reviewed 0024 on PG16.15 AND PG17.11 (identical); exact match required
  functions: [
    { sig: "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", src: "ede022a83e0869ec2194470665cab759", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.refuse_pipeline_kickoff(uuid,text)", src: "fe1b6c137b618527bd5d03b7944e212a", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.settle_pipeline_kickoff(uuid,text,text,text)", src: "35ec51fa266e024de510073414d6e307", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.pipeline_kickoff_record()", src: "f2df109c551f28799a5d107547c90ebc", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)", src: "1616ea311e3da7261bc308ac64293d6c", secdef: true, vol: "s", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_excluded(uuid)", src: "279b1c33d03002d21757c5848056db1a", secdef: false, vol: "i", cfg: "search_path=pg_catalog", acl: "" },
    { sig: "booking.pipeline_kickoff_guard()", src: "01d5d885bcde5cb2f7d0f67aee53fdf9", secdef: false, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" }],
  table: { rls: true, sel: true, ins: false, upd: false, del: false, trg: 1 }
});

export const CONSTANTS = deepFreeze({
  executeEnabled: true,                                            // C112b ENABLE (ONE supervised run; the stacked CLOSE PR restores false); closed constants refuse HKO_EXECUTE_CLOSED
  dispatchEnabled: true,                                           // C112b ENABLE (ONE supervised run; the stacked CLOSE PR restores false); closed constants refuse HKO_DISPATCH_CLOSED
  toolingCommit: "8af49e87149ed7ed83d212714b1f1d173e08c189",       // e7-test #145 MERGE commit (C111 release binding); tree d19b15d6 == the reviewed #145 head c98e8b96
  toolingStatus: "MERGED",                                         // verify / execute refuse HKO_CLOSURE_MISMATCH unless MERGED
  closure: ["lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/pipeline-dispatch-transport.js", "lib/booking-db/pipeline-kickoff.js",
    "lib/booking-db/pool.js", "lib/booking-db/repo.js", "lib/checkout/intent-state.js", "lib/checkout/pipeline-kickoff-plan.js",
    "package-lock.json", "package.json", "scripts/e7-connected/probe-env-preflight.mjs"],
  closureDigest: "4c2a57bde2bb9b073b1b4e443288448aeb96d1f9f96a93412e58149d14e00d2e",   // framed SHA-256 of `closure` at 8af49e87 (identical to the reviewed c98e8b96 bytes) (the test recomputes it from the pinned tree + an independent import scan)
  pipeline: {                                                       // the reviewed C102 ENABLE revision the dispatch targets (9455bc9e)
    runnerFiles: ["scripts/e7-hosted-pipeline.mjs", "test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs", ".github/workflows/e7-hosted-pipeline.yml"],
    sourcePrefix: "e7-hosted-pipeline-v1\n",
    sourceDigest: "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999",
    closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273",
    toolingCommit: "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5"
  },
  scope: {                                                          // must equal the imported consumer KICKOFF_SCOPE exactly (no adoption)
    cutoff: "2026-11-15T22:58:01.000Z", listingId: 606998, currency: "USD",
    excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
      "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]
  },
  dbProjectRef: "mxotevtiscernhqilyiu", environment: "test", nodeVersion: "22.22.0", pgVersion: "8.18.0",
  budgets: { runMs: 90000, teardownMs: 5000, connectMs: 8000, statementMs: 6000, dbQueries: 48, gets: 1, posts: 1, poolMax: 2 }
});
/** the reviewed ENABLE source the imported tooling plan must pin (NOT a seam: compared against the imported PINNED_REVISION) */
export const REVIEWED_PIPELINE_SOURCE = "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999";
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
export const SOURCE_PREFIX = "e7-hosted-kickoff-v1\n";
export const CLOSURE_PREFIX = "e7-hosted-kickoff-closure-v1\n";
export const RUNNER_FILES = freeze(["scripts/e7-hosted-kickoff.mjs", "test/e7-hosted-kickoff.test.mjs", "test/e7-hosted-kickoff-workflow.test.mjs", ".github/workflows/e7-hosted-kickoff.yml"]);
export const TEST_FILES = freeze(["test/e7-hosted-kickoff.test.mjs", "test/e7-hosted-kickoff-workflow.test.mjs"]);
export const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL", "E7_DISPATCH_TOKEN"]);
export const INPUT_ENV = freeze({ intentId: "E7_INTENT_ID", ref: "E7_BOOKING_REF", expectedVersion: "E7_EXPECTED_VERSION", paymentIntentId: "E7_PAYMENT_INTENT_ID", amountMinor: "E7_AMOUNT_MINOR" });
export const ALLOWED_E7_KEYS = freeze([...Object.values(INPUT_ENV), "E7_TOOLING_DIR", "E7_EXPECTED_SOURCE_DIGEST", "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);
export const HOSTED_CODES = freeze(["HKO_USAGE", "HKO_INPUT_UNEXPECTED", "HKO_EXECUTE_CLOSED", "HKO_SECRET_SCOPE_VIOLATION", "HKO_INPUT_INCOMPLETE", "HKO_INPUT_INVALID",
  "HKO_INTENT_EXCLUDED", "HKO_REF_NOT_MAIN", "HKO_BINDING_MISMATCH", "HKO_CLOSURE_MISMATCH", "HKO_LAYOUT_INVALID", "HKO_SOURCE_UNREADABLE", "HKO_SOURCE_MISMATCH",
  "HKO_PIPELINE_NOT_BOUND", "HKO_DEPENDENCY_MISMATCH", "HKO_IMPORT_FAILED", "HKO_ENV_REFUSED", "HKO_CHILD_FAILED", "HKO_TESTS_FAILED", "HKO_CREDENTIALS_MISSING",
  "HKO_DB_TARGET_INVALID", "HKO_CA_INVALID", "HKO_TOOLING_PIN_MISMATCH"]);

const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,96}$/;
const code = (v, fb) => (typeof v === "string" && CODE_RE.test(v) ? v : fb);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
class Refusal extends Error { constructor(c) { super("refused"); this.code = c; } }
const refuse = (c) => { throw new Refusal(c); };

const MAX_FILE = 1048576; const MAX_TOTAL = 8388608;
/** framedDigest(dir, files, prefix): prefix, then per file  <rel> NUL <decimal length> NUL <bytes> NUL  (the reviewed runners' convention) */
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("HKO_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("HKO_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("HKO_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
/** the pg version the LOCKFILE pins (read as text, never imported) */
export function lockedPgVersion(lockText) {
  let j; try { j = JSON.parse(lockText); } catch { return null; }
  const p = isObj(j) && isObj(j.packages) ? j.packages["node_modules/pg"] : null;
  return isObj(p) && typeof p.version === "string" ? p.version : null;
}
/** the pipeline binding, from file BYTES only (never imported): framed source + the closure / tooling literals in the pipeline script */
export async function pipelineBinding(wdir, c = CONSTANTS) {
  const P = c.pipeline;
  const sourceDigest = await framedDigest(wdir, P.runnerFiles, P.sourcePrefix);
  const text = await readFile(`${wdir}/${P.runnerFiles[0]}`, "utf8");
  const lit = (k) => { const m = text.match(new RegExp(`^\\s+${k}: "([0-9a-f]{40}|[0-9a-f]{64})",`, "m")); return m ? m[1] : null; };
  const closureDigest = lit("closureDigest"); const toolingCommit = lit("toolingCommit");
  const bound = sourceDigest === P.sourceDigest && closureDigest === P.closureDigest && toolingCommit === P.toolingCommit;
  return freeze({ sourceDigest, closureDigest, toolingCommit, bound });
}
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
/** wrapper checkout HEAD from .git/HEAD (detached checkout = 40-hex); test seam overrides */
async function readGitHead(wdir) { const t = (await readFile(`${wdir}/.git/HEAD`, "utf8")).trim(); return HEX40.test(t) ? t : null; }

export const CHILD_ENV_ALLOWLIST = freeze(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
export function childEnv(env, toolingDir) {
  const out = {};
  for (const k of CHILD_ENV_ALLOWLIST) if (Object.hasOwn(env, k) && typeof env[k] === "string" && env[k].length <= 4096 && !env[k].includes("\0")) out[k] = env[k];
  out.E7_TOOLING_DIR = toolingDir;
  return out;
}
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 262144) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}

// ---- admission SQL (read-only; every statement is one supervised, counted query) ---------------------------------------------------------
export const QUERIES = freeze({
  session: `/*e7hko:session*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, pg_has_role(current_user, 'mv_booking_admin', 'MEMBER') AS is_admin,
    (SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname = current_user) AS privileged,
    (SELECT pg_has_role(current_user, n.nspowner, 'MEMBER') FROM pg_namespace n WHERE n.nspname = 'booking') AS owns_schema,
    coalesce((SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()), false) AS tls, current_setting('server_version_num')::int AS server_version_num`,
  environment: "/*e7hko:env*/ SELECT environment FROM booking.instance",
  fn: `/*e7hko:fn*/ SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src, p.prosecdef AS secdef, p.provolatile::text AS vol, coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
    coalesce((SELECT string_agg(a.grantee::regrole::text || ':' || a.privilege_type, ',' ORDER BY a.grantee::regrole::text, a.privilege_type) FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '') AS acl
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
  table: `/*e7hko:table*/ SELECT c.relrowsecurity AS rls, has_table_privilege(c.oid, 'SELECT') AS sel, has_table_privilege(c.oid, 'INSERT') AS ins, has_table_privilege(c.oid, 'UPDATE') AS upd,
    has_table_privilege(c.oid, 'DELETE') AS del, (SELECT count(*)::int FROM pg_trigger g WHERE g.tgrelid = 'booking.intents'::regclass AND g.tgname = 'intents_pipeline_kickoff'
    AND g.tgfoid = to_regprocedure('booking.pipeline_kickoff_record()')) AS trg FROM pg_class c WHERE c.oid = to_regclass('booking.pipeline_kickoff_requests')`,
  readback: `/*e7hko:readback*/ SELECT r.state, r.outcome_code, r.claim_worker, r.plan_hash, (r.dispatch_inputs IS NOT NULL) AS has_inputs, (r.settled_at IS NOT NULL) AS settled,
    i.state AS intent_status, i.version AS intent_version FROM booking.pipeline_kickoff_requests r JOIN booking.intents i ON i.id = r.intent_id WHERE r.intent_id = $1`
});
/** consumer codes whose durable effect is UNKNOWN even though claimed:false (C111 F1) → human-owned outcome */
export const UNCERTAIN_CONSUMER_CODES = deepFreeze({ CLAIM_UNCERTAIN: "CLAIM_UNCERTAIN", TX_NOT_CLEAN: "CLAIM_UNCERTAIN", REFUSE_UNCERTAIN: "REFUSE_UNCERTAIN" });
const READBACK_STATES = freeze(["requested", "claimed", "dispatch_accepted", "dispatch_unknown", "dispatch_refused", "refused"]);

/** the exact catalog proof: every reviewed 0024 function / ACL / table privilege / trigger, nothing adopted; schema 23 → refused */
export function catalogRefusal(fns, table, pins = CATALOG_PINS) {
  for (let i = 0; i < pins.functions.length; i += 1) {
    const p = pins.functions[i]; const f = fns[i];
    if (!f) return "SCHEMA_NOT_0024";
    for (const k of ["sig", "src", "secdef", "vol", "cfg", "acl"]) if (f[k] !== p[k]) return `CATALOG_DRIFT:${i}`;
  }
  if (!table) return "SCHEMA_NOT_0024";
  for (const k of Object.keys(pins.table)) if (table[k] !== pins.table[k]) return "CATALOG_DRIFT:TABLE";
  return null;
}

/**
 * runKickoffCore(input) → result. input = { mods, pool, binding, credential, workerId, runSignal?, timer?, clearTimer?, now?, tlsRequired?, constants? }
 *   mods = { runPipelineKickoffOnce, readKickoffFacts, kickoffAdmission, KICKOFF_CONSTANTS, KICKOFF_SCOPE, createGithubWorkflowDispatch,
 *            createGithubExchange, GITHUB_DISPATCH_CONSTANTS, GithubExchangeError }
 *   binding = { intentId, ref, expectedVersion, paymentIntentId, amountMinor, releaseSha }
 * Never throws. ONE consumer invocation for the ONE bound request; every DB / HTTP await is inside ONE seal.
 */
export async function runKickoffCore(input) {
  const c = (input && input.constants) ?? CONSTANTS; const B = c.budgets;
  const r = { schema: "e7-hosted-kickoff-core-v1", outcome: null, code: null, consumerCode: null, claimed: false, dispatchAttempted: false, dispatchOutcome: null,
    gets: 0, posts: 0, postPossiblyStarted: false, credentialReads: 0, dbQueries: 0, dbBudgetRefused: 0, sealed: false, sealReason: null, dbInFlightAtSeal: 0,
    claimInFlightAtSeal: false, clientsDestroyed: 0, lateClientsDestroyed: 0, lateDispatchRefused: 0, readback: null, verified: false };
  let finalized = false;
  const done = (outcome, k) => { if (!finalized) { finalized = true; r.outcome = outcome; r.code = code(String(k), "CODE"); } return r; };
  const setT = input && typeof input.timer === "function" ? input.timer : (fn, ms) => setTimeout(fn, ms);
  const clearT = input && typeof input.clearTimer === "function" ? input.clearTimer : (h) => clearTimeout(h);
  const sealAc = new AbortController(); const sealHooks = new Set(); const tracked = new Set(); let inFlight = 0; let phase = "admission"; let deadlineH = null;
  class Stopped extends Error { constructor() { super("stopped"); this.code = "RUNNER_STOPPED"; } }
  class Timeout extends Error { constructor(k) { super("timeout"); this.code = k; } }
  const destroy = (t) => { if (!t || t.released) return; t.released = true; tracked.delete(t); r.clientsDestroyed += 1; try { t.cl.release(true); } catch { /* contained */ } };
  const finish = (t, destroyIt) => { if (!t || t.released) return; if (destroyIt) { destroy(t); return; } t.released = true; tracked.delete(t); try { t.cl.release(); } catch { /* contained */ } };
  const seal = (why) => {
    if (r.sealed) return;
    r.sealed = true; r.sealReason = code(String(why), "SEALED"); r.dbInFlightAtSeal = inFlight;
    if (phase === "claim" && inFlight > 0) r.claimInFlightAtSeal = true;
    try { sealAc.abort(); } catch { /* ignore */ }
    for (const fn of [...sealHooks]) { try { fn(); } catch { /* ignore */ } }
    sealHooks.clear();
    for (const t of [...tracked]) destroy(t);
  };
  /** supervise(p, ms, onTimeout, k): rejects Stopped on the seal; rejects Timeout after ms (onTimeout first); a late value is DISCARDED */
  const supervise = (p, ms = null, onTimeout = null, k = "TIMEOUT") => new Promise((resolve, reject) => {
    const pp = Promise.resolve(p);
    if (r.sealed) { pp.catch(() => {}); reject(new Stopped()); return; }
    let settled = false; let th = null;
    const fin = (fn) => { if (settled) return; settled = true; sealHooks.delete(onSeal); if (th !== null) { try { clearT(th); } catch { /* ignore */ } } fn(); };
    const onSeal = () => fin(() => reject(new Stopped()));
    sealHooks.add(onSeal);
    if (ms !== null) th = setT(() => fin(() => { try { if (onTimeout) onTimeout(); } catch { /* ignore */ } reject(new Timeout(k)); }), ms);
    pp.then((v) => fin(() => (r.sealed ? reject(new Stopped()) : resolve(v))), (e) => fin(() => reject(r.sealed ? new Stopped() : e)));
  });
  try {
    const { mods, pool, binding, credential, workerId } = input ?? {};
    if (c.dispatchEnabled !== true) return done("STOP", "HKO_DISPATCH_CLOSED");                       // before ANY acquisition
    const need = ["runPipelineKickoffOnce", "readKickoffFacts", "kickoffAdmission", "createGithubWorkflowDispatch", "createGithubExchange"];
    if (!mods || need.some((k) => typeof mods[k] !== "function") || !isObj(mods.KICKOFF_CONSTANTS) || !isObj(mods.KICKOFF_SCOPE) || !isObj(mods.GITHUB_DISPATCH_CONSTANTS)
        || !pool || typeof pool.connect !== "function" || typeof credential !== "function" || typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)
        || !isObj(binding) || !UUID_RE.test(String(binding.intentId)) || !REF_RE.test(String(binding.ref)) || !Number.isSafeInteger(binding.expectedVersion) || binding.expectedVersion < 1
        || !PI_RE.test(String(binding.paymentIntentId)) || !Number.isSafeInteger(binding.amountMinor) || binding.amountMinor < 1 || !HEX40.test(String(binding.releaseSha))) return done("STOP", "CORE_INVALID");
    // the imported consumer scope must EQUAL this runner's reviewed scope (cutoff, listing, currency, every exclusion incl. C103) — no adoption
    const S = mods.KICKOFF_SCOPE;
    if (S.cutoff !== c.scope.cutoff || S.listingId !== c.scope.listingId || S.currency !== c.scope.currency || !Array.isArray(S.excludedIntentIds)
        || c.scope.excludedIntentIds.some((id) => !S.excludedIntentIds.includes(id))) return done("STOP", "SCOPE_DRIFT");
    if (c.scope.excludedIntentIds.includes(binding.intentId)) return done("STOP", "HISTORICAL_TARGET");
    deadlineH = setT(() => seal("DEADLINE"), B.runMs - B.teardownMs);
    if (input.runSignal && typeof input.runSignal.addEventListener === "function") input.runSignal.addEventListener("abort", () => seal("ABORTED"), { once: true });
    if (input.runSignal && input.runSignal.aborted) seal("ABORTED");

    // ---- the supervised pool: bounded acquisition (late client destroyed unused), bounded + counted statements, every client tracked ----
    const acquire = async () => {
      if (r.sealed) throw new Stopped();
      let lost = false; let got = null; let t = null;
      const kill = (cl) => { r.lateClientsDestroyed += 1; try { cl.release(true); } catch { /* contained */ } };
      const pc = Promise.resolve().then(() => pool.connect());
      pc.then((cl) => { got = cl; if ((lost || r.sealed) && cl && !t) kill(cl); }, () => {});
      try {
        const cl = await supervise(pc, B.connectMs, () => seal("DB_CONNECT_TIMEOUT"), "DB_CONNECT_TIMEOUT");
        if (!cl || typeof cl.query !== "function" || typeof cl.release !== "function") { lost = true; if (cl) kill(cl); throw new Refusal("DB_CLIENT_INVALID"); }
        t = { cl, released: false }; tracked.add(t);
        if (r.sealed) { destroy(t); throw new Stopped(); }
        return t;
      } catch (e) { if (!t) { lost = true; if (got) { const g = got; got = null; kill(g); } } throw e; }
    };
    const tq = (t, args) => {
      if (r.sealed || t.released) return Promise.reject(new Stopped());
      if (r.dbQueries >= B.dbQueries) { r.dbBudgetRefused += 1; return Promise.reject(new Refusal("DB_BUDGET")); }
      r.dbQueries += 1; inFlight += 1;
      let qp; try { qp = Promise.resolve(t.cl.query(...args)); } catch (e) { inFlight -= 1; return Promise.reject(e); }
      return supervise(qp, B.statementMs, () => { destroy(t); seal("DB_STATEMENT_TIMEOUT"); }, "DB_STATEMENT_TIMEOUT").finally(() => { inFlight -= 1; });
    };
    const supervisedPool = freeze({                                                                   // a POOL (connect, no release) for the consumer
      connect: async () => { const t = await acquire();
        return { query: (...a) => tq(t, a), release: (arg) => finish(t, arg === true || arg instanceof Error) }; }
    });
    const q = async (sql, params = []) => { const t = await acquire(); let ok = false; try { const res = await tq(t, [sql, params]); ok = true; return res.rows; } finally { finish(t, !ok); } };

    // ---- (1) read-only admission: session role / TLS, environment, the exact 0024 catalog, the ONE bound pristine request ----
    let adm;
    try {
      const s = (await q(QUERIES.session))[0];
      if (!s || s.is_app !== true || s.is_admin !== false || s.privileged !== false || s.owns_schema !== false) return done("STOP", "ROLE_REFUSED");
      if ((input.tlsRequired ?? true) && s.tls !== true) return done("STOP", "TLS_REQUIRED");
      if (!Number.isSafeInteger(s.server_version_num) || s.server_version_num < 160000 || s.server_version_num >= 180000) return done("STOP", "SERVER_VERSION_REFUSED");
      const env = (await q(QUERIES.environment))[0];
      if (!env || env.environment !== c.environment) return done("STOP", "NOT_TEST");
      const fns = [];
      for (const p of CATALOG_PINS.functions) fns.push((await q(QUERIES.fn, [p.sig]))[0] ?? null);
      const table = (await q(QUERIES.table))[0] ?? null;
      const cw = catalogRefusal(fns, table);
      if (cw) return done("STOP", cw);
      const t = await acquire(); let ok = false;
      try { adm = await mods.readKickoffFacts({ query: (...a) => tq(t, a) }, binding.intentId); ok = true; } finally { finish(t, !ok); }
    } catch (e) { return done("STOP", r.sealed ? `SEALED_ADMISSION:${r.sealReason}` : `ADMISSION_READ_FAILED:${code(e && e.code, "ERR")}`); }
    const rq = adm && adm.request; const it = adm && adm.intent;
    if (!rq) return done("STOP", "NO_BOUND_REQUEST");
    if (rq.state !== "requested") return done("STOP", `NOT_PRISTINE:${String(rq.state).toUpperCase()}`);
    if (rq.intent_id !== binding.intentId || rq.ref !== binding.ref || Number(rq.authorized_version) !== binding.expectedVersion
        || rq.payment_intent_id !== binding.paymentIntentId || Number(rq.amount_minor) !== binding.amountMinor || rq.currency !== c.scope.currency
        || Number(rq.listing_id) !== c.scope.listingId) return done("STOP", "BINDING_MISMATCH");
    if (!it || it.version !== binding.expectedVersion || it.status !== "payment_authorized" || !it.payment || it.payment.paymentIntentId !== binding.paymentIntentId
        || it.payment.amountMinor !== binding.amountMinor) return done("STOP", "INTENT_BINDING_MISMATCH");
    const aw = mods.kickoffAdmission(adm);
    if (aw !== null) return done("STOP", `ADMISSION:${code(aw, "REFUSED")}`);               // nothing written: the consumer is never invoked

    // ---- (2) the guarded exchange: <= 1 GET + <= 1 POST, nothing after the seal; the transport is constructed with the release binding ----
    const real = mods.createGithubExchange();
    const exchange = async (spec) => {
      if (r.sealed) { r.lateDispatchRefused += 1; throw new mods.GithubExchangeError("EXCHANGE_SEALED"); }
      if (spec && spec.kind === "getMain") { if (r.gets >= B.gets) throw new mods.GithubExchangeError("EXCHANGE_BUDGET"); r.gets += 1; }
      else if (spec && spec.kind === "dispatch") { if (r.posts >= B.posts) throw new mods.GithubExchangeError("EXCHANGE_BUDGET"); r.posts += 1; r.postPossiblyStarted = true; }
      else throw new mods.GithubExchangeError("EXCHANGE_KIND");
      const sig = AbortSignal.any([spec.signal, sealAc.signal]);
      return supervise(real({ ...spec, signal: sig }), null, null);
    };
    const openTransport = freeze({ ...mods.GITHUB_DISPATCH_CONSTANTS, enabled: true });
    const transport = mods.createGithubWorkflowDispatch({ credential: () => { r.credentialReads += 1; return credential(); }, constants: openTransport, exchange,
      releaseBinding: freeze({ expectedMainSha: binding.releaseSha }) });
    const dispatch = async (call, opts) => {
      if (r.sealed) { r.lateDispatchRefused += 1; return freeze({ notSent: true, code: "SEALED_BEFORE_DISPATCH" }); }
      phase = "dispatch";
      const sig = AbortSignal.any([opts.signal, sealAc.signal]);
      return transport(call, freeze({ signal: sig }));
    };
    const consumerConstants = freeze({ ...mods.KICKOFF_CONSTANTS, dispatchEnabled: true });
    const hooks = freeze({ beforeClaim: async () => { phase = "claim"; }, afterClaim: async () => { phase = "claimed"; r.claimed = true; },
      beforeSettle: async () => { phase = "settle"; } });

    // ---- (3) ONE consumer invocation for the ONE bound request (owned claim COMMIT → dispatch → settle), inside the seal ----
    let out;
    try {
      out = await supervise(mods.runPipelineKickoffOnce(supervisedPool, { workerId, dispatch, constants: consumerConstants, intentId: binding.intentId, hooks }));
    } catch {
      if (r.postPossiblyStarted) return done("UNKNOWN", `SEALED_AFTER_POST:${r.sealReason}`);                 // never upgraded by a late 204
      if (phase === "claim" || phase === "claimed" || phase === "dispatch" || phase === "settle") return done("CLAIM_UNCERTAIN", `SEALED_IN_${phase.toUpperCase()}:${r.sealReason}`);
      return done("STOP", `SEALED:${r.sealReason ?? "ERR"}`);
    }
    r.consumerCode = code(out && out.code, "UNRECOGNIZED"); r.claimed = out && out.claimed === true; r.dispatchAttempted = out && out.dispatchAttempted === true;
    r.dispatchOutcome = out && typeof out.outcome === "string" ? code(out.outcome, null) : null;
    // C111 F1: uncertainty is classified BEFORE the unclaimed return — the consumer reports a lost / rejected claim COMMIT acknowledgement
    // (or a dirty owned connection, or a lost refuse COMMIT) with claimed:false, yet the COMMIT may have landed. Human-owned: no retry.
    if (Object.hasOwn(UNCERTAIN_CONSUMER_CODES, r.consumerCode)) return done(UNCERTAIN_CONSUMER_CODES[r.consumerCode], r.consumerCode);
    if (!r.claimed) return done(r.consumerCode.startsWith("REFUSED:") ? "REFUSED" : "STOP", r.consumerCode);

    // ---- (4) strict sanitized readback (typed allowlist); acceptance is VERIFIED only when the durable row agrees exactly ----
    const accepted = r.dispatchOutcome === "dispatch_accepted" && r.consumerCode === "HANDOFF_ACCEPTED" && out.settled === true && r.posts === 1;
    let rb = null;
    try {
      const rows = await q(QUERIES.readback, [binding.intentId]);
      const x = rows.length === 1 ? rows[0] : null;
      if (x && READBACK_STATES.includes(x.state) && (x.outcome_code === null || (typeof x.outcome_code === "string" && /^[A-Z0-9_:]{1,96}$/.test(x.outcome_code)))
          && typeof x.has_inputs === "boolean" && typeof x.settled === "boolean" && typeof x.intent_status === "string" && Number.isSafeInteger(x.intent_version)) {
        rb = freeze({ state: x.state, outcomeCode: x.outcome_code, workerMatches: x.claim_worker === workerId, planHashPresent: typeof x.plan_hash === "string" && HEX64.test(x.plan_hash),
          hasInputs: x.has_inputs, settled: x.settled, intentStatus: x.intent_status === "payment_authorized" ? "payment_authorized" : "OTHER", intentVersion: x.intent_version });
      }
    } catch { rb = null; }
    r.readback = rb;
    if (accepted) {
      const ok = rb && rb.state === "dispatch_accepted" && rb.outcomeCode === "HANDOFF_ACCEPTED" && rb.workerMatches && rb.planHashPresent && rb.hasInputs && rb.settled
        && rb.intentStatus === "payment_authorized" && rb.intentVersion === binding.expectedVersion;
      if (!ok) return done("ACCEPTED_UNVERIFIED", "READBACK_MISSING_OR_CONTRADICTORY");              // STOP; no extra POST, no repair
      r.verified = true; return done("ACCEPTED_VERIFIED", "HANDOFF_ACCEPTED");
    }
    if (r.postPossiblyStarted || r.dispatchOutcome === "dispatch_unknown") return done("UNKNOWN", r.consumerCode);   // human-owned
    if (r.dispatchOutcome === "dispatch_refused") return done("NOT_SENT", r.consumerCode);
    return done("CLAIM_UNCERTAIN", r.consumerCode);
  } catch (e) {
    return done(r.postPossiblyStarted ? "UNKNOWN" : "STOP", `CORE_INTERNAL:${code(e && e.code, "ERR")}`);
  } finally {
    if (deadlineH !== null) { try { clearT(deadlineH); } catch { /* ignore */ } }
    seal(r.sealed ? r.sealReason : "CORE_END");                                                        // no DB / dispatch admission after the core returns
    if (r.sealReason === "CORE_END") { r.sealed = false; r.sealReason = null; }                        // a normal end is not reported as a seal
  }
}

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS (constants included). */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const r = { schema: "e7-hosted-kickoff-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, executeEnabled: c.executeEnabled,
    dispatchEnabled: c.dispatchEnabled, closureDigest: null, sourceDigest: null, pipeline: null, envCode: null, tests: null, runId: null, core: null, cleanup: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HKO_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                                // key NAMES only — no value is read before the next two gates
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("HKO_INPUT_UNEXPECTED");
    if (mode !== "preflight" && c.executeEnabled !== true) refuse("HKO_EXECUTE_CLOSED");   // SHIPPED: refuses HERE
    if (mode !== "execute" && SECRET_KEYS.some((k) => keys.includes(k))) refuse("HKO_SECRET_SCOPE_VIOLATION");
    const spawnChild = deps.spawnChild ?? spawnNode;
    const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
    const importTooling = deps.importTooling ?? defaultImportTooling;
    const runCore = deps.runCore ?? runKickoffCore;
    const readHead = deps.readHead ?? readGitHead;
    const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
    const readCa = deps.readCa ?? ((p) => readFile(p));
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const inp = {}; for (const k of Object.keys(INPUT_ENV)) inp[k] = env[INPUT_ENV[k]] ?? "";
    const vals = Object.values(inp); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HKO_INPUT_INCOMPLETE");
    if (anyReal && (!UUID_RE.test(inp.intentId) || !REF_RE.test(inp.ref) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion) || !PI_RE.test(inp.paymentIntentId)
        || !/^[1-9][0-9]{0,7}$/.test(inp.amountMinor))) refuse("HKO_INPUT_INVALID");
    if (anyReal && c.scope.excludedIntentIds.includes(inp.intentId)) refuse("HKO_INTENT_EXCLUDED");
    const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HKO_CLOSURE_MISMATCH");
      if (!anyReal || !HEX64.test(expSrc)) refuse("HKO_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("HKO_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HKO_REF_NOT_MAIN");
      if (r.workflowSha === null || env.GITHUB_SHA !== r.workflowSha) refuse("HKO_BINDING_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HKO_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HKO_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HKO_LAYOUT_INVALID");
    // ---- closure (tooling bytes) + lockfile pg pin BEFORE any tooling import ----
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HKO_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HKO_CLOSURE_MISMATCH");
    if (lockedPgVersion(await readFile(`${tooling}/package-lock.json`, "utf8").catch(() => "")) !== c.pgVersion) refuse("HKO_DEPENDENCY_MISMATCH");
    // ---- own source + the PIPELINE release binding, from bytes only, BEFORE any secret ----
    r.sourceDigest = await framedDigest(wdir, RUNNER_FILES, SOURCE_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HKO_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.sourceDigest !== expSrc) refuse("HKO_SOURCE_MISMATCH");
    r.pipeline = await pipelineBinding(wdir, c).catch((e) => refuse(e instanceof Refusal ? e.code : "HKO_SOURCE_UNREADABLE"));
    if (mode !== "preflight") {
      if (r.pipeline.bound !== true) refuse("HKO_PIPELINE_NOT_BOUND");                                 // wrong / closed / stale pipeline → 0 credential, 0 POST
      let head = null; try { head = await readHead(wdir); } catch { head = null; }
      if (head !== r.workflowSha) refuse("HKO_BINDING_MISMATCH");                                     // the checked-out wrapper IS github.sha
    }
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HKO_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HKO_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", ...TEST_FILES], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HKO_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m) };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HKO_TESTS_FAILED");
      r.code = r.pipeline.bound ? "PREFLIGHT_OK_PIPELINE_BOUND" : "PREFLIGHT_OK_PIPELINE_NOT_BOUND"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- execute: the ONLY step with the two secrets ----
    r.runId = runId;
    if (!SECRET_KEYS.every((k) => typeof env[k] === "string" && env[k].length > 0)) refuse("HKO_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    let tok = env.E7_DISPATCH_TOKEN; delete env.E7_DISPATCH_TOKEN;
    try {
      if (!TOKEN_RE.test(tok)) refuse("HKO_CREDENTIALS_MISSING");
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("HKO_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("HKO_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("HKO_CA_INVALID");
      let mods; try { mods = await importTooling(tooling); } catch { refuse("HKO_IMPORT_FAILED"); }
      if (!isObj(mods.PINNED_REVISION) || mods.PINNED_REVISION.sourceDigest !== REVIEWED_PIPELINE_SOURCE || mods.PINNED_REVISION.closureDigest !== c.pipeline.closureDigest) refuse("HKO_TOOLING_PIN_MISMATCH");
      try { pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: c.budgets.poolMax }); } catch { refuse("HKO_DB_TARGET_INVALID"); }
      dbUrl = null;
      const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
      const t0 = tok;
      try {
        r.core = await runCore({ mods, pool, credential: () => t0, workerId: `hko:${runId}`, runSignal: ac.signal, constants: c,
          binding: { intentId: inp.intentId, ref: inp.ref, expectedVersion: Number(inp.expectedVersion), paymentIntentId: inp.paymentIntentId,
            amountMinor: Number(inp.amountMinor), releaseSha: r.workflowSha } });
      } finally { proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    } finally { dbUrl = null; tok = null; }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "ACCEPTED_VERIFIED" && r.core.verified === true ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HKO_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    if (pool) { try { await Promise.race([pool.end(), new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 5000))]); r.cleanup = "POOL_ENDED"; } catch { r.cleanup = "POOL_END_FAILED"; } }
  }
}
export async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [K, T, PL, P] = await Promise.all([import(u("lib/booking-db/pipeline-kickoff.js")), import(u("lib/booking-db/pipeline-dispatch-transport.js")),
    import(u("lib/checkout/pipeline-kickoff-plan.js")), import(u("lib/booking-db/pool.js"))]);
  return freeze({ runPipelineKickoffOnce: K.runPipelineKickoffOnce, readKickoffFacts: K.readKickoffFacts, kickoffAdmission: K.kickoffAdmission, KICKOFF_CONSTANTS: K.KICKOFF_CONSTANTS,
    KICKOFF_SCOPE: PL.KICKOFF_SCOPE, PINNED_REVISION: PL.PINNED_REVISION, createGithubWorkflowDispatch: T.createGithubWorkflowDispatch, createGithubExchange: T.createGithubExchange,
    GITHUB_DISPATCH_CONSTANTS: T.GITHUB_DISPATCH_CONSTANTS, GithubExchangeError: T.GithubExchangeError, createBookingPool: P.createBookingPool });
}
export function summaryMarkdown(r) {
  const k = r.core ? ` core=${r.core.outcome}/${r.core.code} consumer=${r.core.consumerCode ?? "-"} gets=${r.core.gets} posts=${r.core.posts} verified=${r.core.verified === true} sealed=${r.core.sealed}` : "";
  return `e7-hosted-kickoff ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} dispatchEnabled=${r.dispatchEnabled} pipelineBound=${r.pipeline ? r.pipeline.bound : "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"} cleanup=${r.cleanup ?? "-"}${k}\n`;
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("../", import.meta.url));
  runHosted({ mode, env: process.env, proc: process, wrapperDir }).then(({ exitCode, result }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string" && process.env.GITHUB_STEP_SUMMARY.length > 0) {
      import("node:fs/promises").then((fs) => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result))).catch(() => {}).finally(() => process.exit(exitCode));
    } else process.exit(exitCode);
  }).catch(() => process.exit(1));
}
