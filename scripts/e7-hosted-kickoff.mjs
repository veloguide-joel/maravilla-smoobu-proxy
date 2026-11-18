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
// digest 5294b6b4…c3f5 (C119 S4; C116 880db5b3; was f09bcbbd…0999) and that the pipeline's pinned closure is f7d7cad6…7273. GET refs/heads/main must then equal that sha (main has not moved),
// otherwise the transport returns notSent and 0 POST happens. Wrong / closed / stale pipeline source or a foreign HEAD → 0 credential read, 0 POST.
//
// SUPERVISION (the C91 pattern, re-implemented here; the pipeline runner is not edited): ONE seal (wall deadline / run abort / a local connect or
// statement timeout) ends ALL DB and dispatch admission at once — every tracked client is destroyed, late clients are destroyed unused, late
// statements are refused, the guarded exchange refuses any GET / POST after the seal, and a late consumer result is DISCARDED (never upgraded).
// In-flight claim / COMMIT at the seal → 0 dispatch (human-owned). A possibly started POST → UNKNOWN, never upgraded by a late 204.
// The DB session is the runtime app role over TLS with the pinned CA (never the owner / admin role); ONE consumer invocation for ONE bound
// C112 TLS (BOTH hops, no exception path): (a) CLIENT hop — EVERY acquired client (admission AND consumer) must show, on its OWN socket and
// BEFORE its first statement, a live node:tls socket that completed an authorized handshake (CA chain + hostname, no resumed session) whose
// peer certificate independently passes tls.checkServerIdentity(CONSTANTS.tls.host), with the pinned CA and rejectUnauthorized:true in force;
// otherwise the client is destroyed unused, the core is sealed and the run STOPs TLS_REQUIRED:CLIENT_<reason>. (b) BACKEND hop — the
// server-reported pg_stat_ssl.ssl of the backend serving the session query must be true (through the Supabase shared pooler this is the
// pooler→Postgres hop, which the project's "Enforce SSL" setting governs); otherwise STOP TLS_REQUIRED:BACKEND_HOP. Neither proves the other.
// request (never a queue sweep, never an auto-resume). UNKNOWN / claimed uncertainty is human-owned: no retry, recovery or repair.
//
// C113 DETECT (manual workflow_dispatch only; no schedule): mode `detect` finds the ONE eligible durable request server-side in ONE always-
// rolled-back REPEATABLE READ READ ONLY snapshot (0 → NO_REQUEST, 1 → ONE + a candidate fingerprint, >1 → AMBIGUOUS; never "the oldest") and
// returns BEFORE any transport / credential / claim. The separately gated execute then runs with binding.source "selected": it RE-SELECTS
// inside runKickoffCore's OWN seal / deadline / statement counter, requires the same fingerprint, and continues on the unchanged path. The
// 0 / 1 / >1 decision is made at that snapshot only (a row committed after it is not seen and stays requested); the invariant is per-row
// exactly-once (single-winner claim + revalidation), not global cardinality. Live-main movement is detected only by the transport's GET.
//
// The ONLY top-level effect is the guarded main() at the bottom. No schedule / cron / webhook / route triggers this file (dispatch only).
// C119 S2 (DRAFT, SHIPPED CLOSED): the TEST ARM gate. verify / detect / execute (manual OR scheduled — no manual bypass) additionally require the
//   repository variable E7_TEST_AUTO_ARMED (passed as E7_TEST_ARM) to EQUAL the release digest RECOMPUTED here from this checkout (labelled copy of
//   scripts/e7-test-arm.mjs; the caller-supplied value is never the authority). Detect-flow verify not armed → CLOSED_NOOP (open=false: the gated
//   jobs are skipped); any other mode not armed → HKO_ARM_CLOSED — before any tooling import, secret value, DB, token or HTTP. The scheduled source
//   pin now comes from the arm job's recomputed kickoff frame (vars.E7_KICKOFF_EXPECTED_SOURCE is retired). Manual preflight is unchanged.
//   C119 S4: the pipeline is now arm-gated too (P0 arm job, P4 labelled arm gate) and REQUEST-BOUND (P5: only this claim's exact frozen inputs run);
//   every gated job (kickoff detect / execute included) re-checks the LIVE main ref after any queue / approval delay (P3) — revocation = a CLOSE commit.
//   PROVEN: refusal whenever the value it RECEIVES (from the GitHub vars context) differs; UNVERIFIED: when GitHub refreshes that context for an already
//   queued / approval-held job (no live configuration fetch here). Clearing the variable must NOT be relied on to revoke queued / pending-approval /
//   already-running work (a pre-activation blocker).
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import tls from "node:tls";
import { spawn } from "node:child_process";

const freeze = Object.freeze;
const deepFreeze = (o) => { if (o && typeof o === "object") { for (const v of Object.values(o)) deepFreeze(v); freeze(o); } return o; };

export const CATALOG_PINS = deepFreeze({                         // derived from the reviewed 0024 on PG16.15 AND PG17.11 (identical); exact match required. C116: the claim src is 0026's (fb103173 on PG16 + PG17; was ede022a8 at 0024 — a schema-25 claim is CATALOG_DRIFT:0)
  functions: [
    { sig: "booking.claim_pipeline_kickoff(uuid,text,text,jsonb)", src: "98ffe6c804377b46b0d3d8907ac7d284", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.refuse_pipeline_kickoff(uuid,text)", src: "fe1b6c137b618527bd5d03b7944e212a", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.settle_pipeline_kickoff(uuid,text,text,text)", src: "35ec51fa266e024de510073414d6e307", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "mv_booking_app:EXECUTE" },
    { sig: "booking.pipeline_kickoff_record()", src: "f2df109c551f28799a5d107547c90ebc", secdef: true, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_refusal(booking.intents,booking.pipeline_kickoff_requests)", src: "1616ea311e3da7261bc308ac64293d6c", secdef: true, vol: "s", cfg: "search_path=pg_catalog, booking", acl: "" },
    { sig: "booking.pipeline_kickoff_excluded(uuid)", src: "279b1c33d03002d21757c5848056db1a", secdef: false, vol: "i", cfg: "search_path=pg_catalog", acl: "" },
    { sig: "booking.pipeline_kickoff_guard()", src: "01d5d885bcde5cb2f7d0f67aee53fdf9", secdef: false, vol: "v", cfg: "search_path=pg_catalog, booking", acl: "" }],
  table: { rls: true, sel: true, ins: false, upd: false, del: false, trg: 1 }
});

export const CONSTANTS = deepFreeze({
  executeEnabled: false,                                           // SHIPPED CLOSED: verify / execute refuse HKO_EXECUTE_CLOSED from key names only
  dispatchEnabled: false,                                          // SHIPPED CLOSED: the core refuses HKO_DISPATCH_CLOSED before any DB acquisition
  toolingCommit: "71750f58a2d6df8143098431edbd86a393897933",       // C119 S4: the DRAFT tooling head (0028 + PINNED_REVISION 5294b6b4; tree 3057af31). C116: 66133a22 (#180 merge)
  toolingStatus: "DRAFT_HEAD",                                     // C119 S4: NOT merged yet → verify / execute refuse HKO_CLOSURE_MISMATCH (fail-closed); repinned to the e7-test MERGE commit (same tree) + MERGED before this PR merges
  closure: ["lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/pipeline-dispatch-transport.js", "lib/booking-db/pipeline-kickoff.js",
    "lib/booking-db/pool.js", "lib/booking-db/repo.js", "lib/checkout/intent-state.js", "lib/checkout/pipeline-kickoff-plan.js",
    "package-lock.json", "package.json", "scripts/e7-connected/probe-env-preflight.mjs"],
  closureDigest: "573dae82aad8b7e9fc208fbc1b0887b5a582348cacdd24cdded73f0ac5badc17",   // C119 S4: framed SHA-256 of `closure` at 71750f58 (only lib/checkout/pipeline-kickoff-plan.js + lib/booking-db/pipeline-dispatch-transport.js differ from 66133a22 e180398f); the test recomputes it
  pipeline: {                                                       // the reviewed C102 ENABLE revision the dispatch targets (9455bc9e)
    runnerFiles: ["scripts/e7-hosted-pipeline.mjs", "test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs", ".github/workflows/e7-hosted-pipeline.yml"],
    sourcePrefix: "e7-hosted-pipeline-v1\n",
    sourceDigest: "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5",   // C116 ENABLE frame (was f09bcbbd at 9455bc9e)
    closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273",
    toolingCommit: "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5"
  },
  scope: {                                                          // must equal the imported consumer KICKOFF_SCOPE exactly (no adoption)
    cutoff: "2026-11-15T22:58:01.000Z", listingId: 606998, currency: "USD",
    excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
      "669da884-02e8-4105-8825-f908e5d22ae9", "1d6e770f-ba3d-40f7-92c1-ee01be7da532"]
  },
  tls: { host: "aws-0-us-east-1.pooler.supabase.com", caSha256: "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7" },  // C112: client-hop identity (== dbTargetOk host, OFFICIAL_CA_SHA256)
  dbProjectRef: "mxotevtiscernhqilyiu", environment: "test", nodeVersion: "22.22.0", pgVersion: "8.18.0",
  budgets: { runMs: 90000, teardownMs: 5000, connectMs: 8000, statementMs: 6000, dbQueries: 48, gets: 1, posts: 1, poolMax: 2 },
  detect: { budgets: { runMs: 60000, teardownMs: 5000, connectMs: 8000, statementMs: 6000, dbQueries: 24, gets: 0, posts: 0, poolMax: 1 } }   // C113 detect job
});
/** the reviewed ENABLE source the imported tooling plan must pin (NOT a seam: compared against the imported PINNED_REVISION) */
export const REVIEWED_PIPELINE_SOURCE = "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5";   // C116 (was f09bcbbd)
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
export const SOURCE_PREFIX = "e7-hosted-kickoff-v1\n";
export const CLOSURE_PREFIX = "e7-hosted-kickoff-closure-v1\n";
export const RUNNER_FILES = freeze(["scripts/e7-hosted-kickoff.mjs", "test/e7-hosted-kickoff.test.mjs", "test/e7-hosted-kickoff-workflow.test.mjs", ".github/workflows/e7-hosted-kickoff.yml"]);
export const TEST_FILES = freeze(["test/e7-hosted-kickoff.test.mjs", "test/e7-hosted-kickoff-workflow.test.mjs"]);
export const SECRET_KEYS = freeze(["E7_DEV_BOOKING_DATABASE_URL", "E7_DISPATCH_TOKEN"]);
export const INPUT_ENV = freeze({ intentId: "E7_INTENT_ID", ref: "E7_BOOKING_REF", expectedVersion: "E7_EXPECTED_VERSION", paymentIntentId: "E7_PAYMENT_INTENT_ID", amountMinor: "E7_AMOUNT_MINOR" });
export const ALLOWED_E7_KEYS = freeze([...Object.values(INPUT_ENV), "E7_TOOLING_DIR", "E7_EXPECTED_SOURCE_DIGEST", "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS,
  "E7_INPUT_MODE", "E7_EXPECTED_CANDIDATE_FINGERPRINT", "E7_TEST_ARM"]);                     // C113: the workflow mode + the detect job's declared output; C119 S2: the arm
/** C113: the workflow input `mode` values the runner admits in E7_INPUT_MODE (public, never a binding) */
export const INPUT_MODES = freeze(["preflight", "verify", "execute", "detect"]);
export const HOSTED_CODES = freeze(["HKO_USAGE", "HKO_INPUT_UNEXPECTED", "HKO_EXECUTE_CLOSED", "HKO_SECRET_SCOPE_VIOLATION", "HKO_INPUT_INCOMPLETE", "HKO_INPUT_INVALID",
  "HKO_INTENT_EXCLUDED", "HKO_REF_NOT_MAIN", "HKO_BINDING_MISMATCH", "HKO_CLOSURE_MISMATCH", "HKO_LAYOUT_INVALID", "HKO_SOURCE_UNREADABLE", "HKO_SOURCE_MISMATCH",
  "HKO_PIPELINE_NOT_BOUND", "HKO_DEPENDENCY_MISMATCH", "HKO_IMPORT_FAILED", "HKO_ENV_REFUSED", "HKO_CHILD_FAILED", "HKO_TESTS_FAILED", "HKO_CREDENTIALS_MISSING", "HKO_CREDENTIAL_FORMAT_UNSUPPORTED",
  "HKO_DB_TARGET_INVALID", "HKO_CA_INVALID", "HKO_TOOLING_PIN_MISMATCH", "HKO_ARM_CLOSED"]);
/** C113: the ONLY detect job outputs (allowlisted enums) — an identifier is never an output */
export const DETECT_OUTCOME_RE = /^(NO_REQUEST|ONE|AMBIGUOUS|INELIGIBLE:[A-Z0-9_:]{1,80}|STOP)$/;

const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
// C112 F1: the SAME opaque GitHub token-shape rule as the tooling transport's githubTokenRefusal (parity is test-asserted): classic
// [A-Za-z0-9_]{20,255} OR the stateless ghs_ GITHUB_TOKEN (a ghs_-prefixed JWT, ~520 chars, dots / hyphens), total cap 2048. Never decoded;
// no claim trusted; no whitespace / CR / LF / control character can pass (no header injection). Checked BEFORE any tooling import.
export const TOKEN_MAX_LENGTH = 2048;
export function tokenShapeOk(t) {
  return typeof t === "string" && t.length > 0 && t.length <= TOKEN_MAX_LENGTH && (/^[A-Za-z0-9_]{20,255}$/.test(t) || /^ghs_[A-Za-z0-9._-]{36,2044}$/.test(t));
}
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

// ---- C119 S2: LABELLED COPY of scripts/e7-test-arm.mjs (the release computation + arm decision; asserted byte-equal by test/e7-test-arm.test.mjs) ----
const ARM_HEX64 = /^[0-9a-f]{64}$/;
const ARM_PATH_RE = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const ARM_PREFIX_RE = /^[a-z0-9-]{1,60}-v1\n$/;
function armCanonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(armCanonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${armCanonical(v[k])}`).join(",")}}`;
}
const armSha = (b) => createHash("sha256").update(b).digest("hex");
async function armFrame(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const st = await lstat(`${dir}/${rel}`);
    if (!st.isFile() || st.size < 1 || st.size > 1048576) throw new Error("ARM_FILE");
    const b = await readFile(`${dir}/${rel}`); if (b.length !== st.size) throw new Error("ARM_FILE");
    total += b.length; if (total > 8388608) throw new Error("ARM_FILE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
/** armRelease(dir) → { ok: true, release, manifest, frames } | { ok: false } — the manifest is parsed STRICTLY; never throws */
export async function armRelease(dir) {
  try {
    const p = `${dir}/scripts/e7-test-arm/manifest.json`; const st = await lstat(p);
    if (!st.isFile() || st.size < 2 || st.size > 65536) return { ok: false };
    const bytes = await readFile(p); const m = JSON.parse(bytes.toString("utf8"));
    if (!m || typeof m !== "object" || Array.isArray(m) || JSON.stringify(Object.keys(m)) !== JSON.stringify(["schema", "components"]) || m.schema !== "e7-test-arm-manifest-v1") return { ok: false };
    const want = ["arm-gate", "kickoff", "booking-confirmation", "pipeline"];
    if (!Array.isArray(m.components) || m.components.length !== want.length) return { ok: false };
    const seen = new Set(); const comps = []; const frames = {};
    for (let i = 0; i < want.length; i += 1) {
      const x = m.components[i];
      if (!x || typeof x !== "object" || Array.isArray(x) || JSON.stringify(Object.keys(x)) !== JSON.stringify(["name", "prefix", "files"]) || x.name !== want[i]) return { ok: false };
      if (typeof x.prefix !== "string" || !ARM_PREFIX_RE.test(x.prefix) || !Array.isArray(x.files) || x.files.length < 1 || x.files.length > 8) return { ok: false };
      for (const f of x.files) {
        if (typeof f !== "string" || !ARM_PATH_RE.test(f) || f.split("/").some((s) => s === "." || s === "..") || seen.has(f)
            || ["scripts/e7-test-arm/manifest.json", "test/e7-cross-runner-regression.test.mjs", ".github/workflows/e7-cross-runner-regression.yml"].includes(f)) return { ok: false };
        seen.add(f);
      }
      const frame = await armFrame(dir, x.files, x.prefix);
      comps.push({ name: x.name, frame }); frames[x.name] = frame;
    }
    const manifest = armSha(bytes);
    return { ok: true, release: armSha(armCanonical({ schema: "e7-test-arm-release-v1", manifest, components: comps })), manifest, frames };
  } catch { return { ok: false }; }
}
/** armDecision({ dir, value, ref }) → frozen { armed, code, release, frames } — absent / malformed / ref / unreadable / mismatch → NOT armed */
export async function armDecision({ dir, value, ref }) {
  const no = (code, rel = null) => Object.freeze({ armed: false, code, release: rel, frames: null });
  if (value === undefined || value === null || value === "") return no("ARM_ABSENT");
  if (typeof value !== "string" || !ARM_HEX64.test(value)) return no("ARM_MALFORMED");
  if (ref !== "refs/heads/main") return no("ARM_REF_NOT_MAIN");
  const r = await armRelease(dir);
  if (!r.ok) return no("ARM_RELEASE_UNREADABLE");
  if (r.release !== value) return no("ARM_MISMATCH", r.release);
  return Object.freeze({ armed: true, code: "ARMED", release: r.release, frames: Object.freeze({ ...r.frames }) });
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
  // C113: ONE always-rolled-back read-only snapshot; the 0 / 1 / >1 decision is made here only (LIMIT 2; never "the oldest")
  snapBegin: "/*e7hko:snapbegin*/ BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  snapEnd: "/*e7hko:snapend*/ ROLLBACK",
  detect: `/*e7hko:detect*/ SELECT r.intent_id::text AS intent_id, r.ref, r.authorized_version, r.payment_intent_id, r.amount_minor::text AS amount_minor
    FROM booking.pipeline_kickoff_requests r JOIN booking.intents i ON i.id = r.intent_id
    WHERE r.state = 'requested' AND r.listing_id = $1 AND r.currency = $2 AND r.intent_created_at >= $3::timestamptz
      AND NOT (r.intent_id = ANY ($4::uuid[]))
      AND i.environment = 'test' AND i.payment_livemode = false AND i.state = 'payment_authorized' AND i.version = r.authorized_version
    ORDER BY r.intent_id LIMIT 2`,
  readback: `/*e7hko:readback*/ SELECT r.state, r.outcome_code, r.claim_worker, r.plan_hash, (r.dispatch_inputs IS NOT NULL) AS has_inputs, (r.settled_at IS NOT NULL) AS settled,
    i.state AS intent_status, i.version AS intent_version FROM booking.pipeline_kickoff_requests r JOIN booking.intents i ON i.id = r.intent_id WHERE r.intent_id = $1`
});
/** consumer codes whose durable effect is UNKNOWN even though claimed:false (C111 F1) → human-owned outcome */
export const UNCERTAIN_CONSUMER_CODES = deepFreeze({ CLAIM_UNCERTAIN: "CLAIM_UNCERTAIN", TX_NOT_CLEAN: "CLAIM_UNCERTAIN", REFUSE_UNCERTAIN: "REFUSE_UNCERTAIN" });
const READBACK_STATES = freeze(["requested", "claimed", "dispatch_accepted", "dispatch_unknown", "dispatch_refused", "refused"]);

/**
 * C112 CLIENT-hop TLS evidence for ONE acquired pg client, read from the client's OWN socket (never from server text, env or input).
 * → null (verified) or a reason. Node sets socket.authorized only after the CA chain AND checkServerIdentity passed (lib/_tls_wrap.js
 * onConnectSecure); a resumed session skips that identity check, so it is refused, and the identity is re-checked here against the reviewed
 * host independently of the name the socket used. The pg config must still carry rejectUnauthorized:true and the pinned CA bytes.
 */
export function clientTlsRefusal(cl, policy) {
  try {
    if (!isObj(policy) || typeof policy.host !== "string" || !HEX64.test(String(policy.caSha256))) return "POLICY_INVALID";
    const st = cl && cl.connection && cl.connection.stream;
    if (!st) return "NO_EVIDENCE";
    if (!(st instanceof tls.TLSSocket) || st.encrypted !== true) return "NOT_TLS";
    if (st.destroyed !== false || st.readyState !== "open") return "DISCONNECTED";
    if (st.authorized !== true || st.authorizationError != null) return "UNAUTHORIZED";
    if (typeof st.isSessionReused !== "function" || st.isSessionReused() !== false) return "SESSION_REUSED";
    const proto = typeof st.getProtocol === "function" ? st.getProtocol() : null;
    if (proto !== "TLSv1.3" && proto !== "TLSv1.2") return "PROTOCOL";
    const cert = typeof st.getPeerCertificate === "function" ? st.getPeerCertificate() : null;
    if (!isObj(cert) || Object.keys(cert).length === 0) return "NO_PEER_CERT";
    if (tls.checkServerIdentity(policy.host, cert) !== undefined) return "HOSTNAME_MISMATCH";
    if (cl.host !== policy.host) return "HOST_MISMATCH";
    const ssl = cl.ssl;
    if (!isObj(ssl) || ssl.rejectUnauthorized !== true || typeof ssl.ca !== "string" || sha(Buffer.from(ssl.ca, "utf8")) !== policy.caSha256
        || ssl.checkServerIdentity !== undefined) return "CONFIG_NOT_PINNED";
    return null;
  } catch { return "EVIDENCE_ERROR"; }
}

/**
 * C113 candidate fingerprint (merged contract rev 2): sha256 over UTF-8 "e7-kickoff-candidate-v1" \n intent_id \n ref \n authorized_version \n
 * payment_intent_id \n amount_minor — lowercase uuid, base-10 integers (no sign / leading zeros), no trailing newline. → 64-hex or null.
 */
export const CANDIDATE_PREFIX = "e7-kickoff-candidate-v1";
export function candidateFingerprint(x) {
  if (!isObj(x)) return null;
  const id = typeof x.intentId === "string" ? x.intentId.toLowerCase() : "";
  if (!UUID_RE.test(id) || !REF_RE.test(String(x.ref)) || !Number.isSafeInteger(x.version) || x.version < 1 || !PI_RE.test(String(x.paymentIntentId))
      || !Number.isSafeInteger(x.amountMinor) || x.amountMinor < 1) return null;
  return sha([CANDIDATE_PREFIX, id, x.ref, String(x.version), x.paymentIntentId, String(x.amountMinor)].join("\n"));
}
const MANUAL_KEYS = freeze(["intentId", "ref", "expectedVersion", "paymentIntentId", "amountMinor", "releaseSha"]);
const manualBindingOk = (b) => isObj(b) && UUID_RE.test(String(b.intentId)) && REF_RE.test(String(b.ref)) && Number.isSafeInteger(b.expectedVersion) && b.expectedVersion >= 1
  && PI_RE.test(String(b.paymentIntentId)) && Number.isSafeInteger(b.amountMinor) && b.amountMinor >= 1 && HEX40.test(String(b.releaseSha));
const exactKeys = (o, ks) => { const k = Object.keys(o); return k.length === ks.length && ks.every((x) => Object.hasOwn(o, x)); };
/**
 * C113 binding.source seam: { source?: "manual", …6 fields } | { source: "selected", expectedFingerprint, releaseSha } | { source: "detect" }.
 * Unknown tags / extra or missing keys → null (CORE_INVALID). A source-less binding is the existing manual shape (compatibility).
 */
export function parseBinding(raw) {
  if (!isObj(raw)) return null;
  const src = Object.hasOwn(raw, "source") ? raw.source : "manual";
  if (src === "manual") {
    const { source, ...rest } = raw;
    return exactKeys(rest, MANUAL_KEYS) && manualBindingOk(rest) ? freeze({ source: "manual", binding: freeze({ ...rest }) }) : null;
  }
  if (src === "selected") return exactKeys(raw, ["source", "expectedFingerprint", "releaseSha"]) && HEX64.test(String(raw.expectedFingerprint)) && HEX40.test(String(raw.releaseSha))
    ? freeze({ source: "selected", expectedFingerprint: raw.expectedFingerprint, releaseSha: raw.releaseSha }) : null;
  if (src === "detect") return exactKeys(raw, ["source"]) ? freeze({ source: "detect" }) : null;
  return null;
}
const candidateOf = (row) => ({ intentId: String(row.intent_id), ref: row.ref, version: Number(row.authorized_version), paymentIntentId: row.payment_intent_id,
  amountMinor: Number(row.amount_minor) });

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

/** the bound-row / intent equality proof (the pre-C113 inline checks, unchanged in order and codes) → null or a STOP code */
export function bindingRefusal(adm, binding, c = CONSTANTS) {
  const rq = adm && adm.request; const it = adm && adm.intent;
  if (!rq) return "NO_BOUND_REQUEST";
  if (rq.state !== "requested") return `NOT_PRISTINE:${String(rq.state).toUpperCase()}`;
  if (rq.intent_id !== binding.intentId || rq.ref !== binding.ref || Number(rq.authorized_version) !== binding.expectedVersion
      || rq.payment_intent_id !== binding.paymentIntentId || Number(rq.amount_minor) !== binding.amountMinor || rq.currency !== c.scope.currency
      || Number(rq.listing_id) !== c.scope.listingId) return "BINDING_MISMATCH";
  if (!it || it.version !== binding.expectedVersion || it.status !== "payment_authorized" || !it.payment || it.payment.paymentIntentId !== binding.paymentIntentId
      || it.payment.amountMinor !== binding.amountMinor) return "INTENT_BINDING_MISMATCH";
  return null;
}

/**
 * runKickoffCore(input) → result. input = { mods, pool, binding, credential, workerId, runSignal?, timer?, clearTimer?, now?, constants? }  (no TLS opt-out exists)
 *   binding (C113) = the existing manual shape | { source: "selected", expectedFingerprint, releaseSha } | { source: "detect" } (see parseBinding).
 *   "detect" returns outcome DETECTED (NO_REQUEST / ONE / AMBIGUOUS / INELIGIBLE:*) BEFORE any transport, credential or claim; no workerId /
 *   credential is accepted. "selected" re-selects inside THIS seal / deadline / counter, then continues on the unchanged manual path.
 *   mods = { runPipelineKickoffOnce, readKickoffFacts, kickoffAdmission, KICKOFF_CONSTANTS, KICKOFF_SCOPE, createGithubWorkflowDispatch,
 *            createGithubExchange, GITHUB_DISPATCH_CONSTANTS, GithubExchangeError }
 *   binding = { intentId, ref, expectedVersion, paymentIntentId, amountMinor, releaseSha }
 * Never throws. ONE consumer invocation for the ONE bound request; every DB / HTTP await is inside ONE seal.
 */
export async function runKickoffCore(input) {
  const c = (input && input.constants) ?? CONSTANTS;
  const parsed = parseBinding(input && input.binding);                                   // C113: the ONE binding seam (manual / selected / detect)
  const B = parsed && parsed.source === "detect" ? (c.detect && c.detect.budgets) : c.budgets;
  const r = { schema: "e7-hosted-kickoff-core-v1", outcome: null, code: null, consumerCode: null, claimed: false, dispatchAttempted: false, dispatchOutcome: null,
    gets: 0, posts: 0, postPossiblyStarted: false, credentialReads: 0, dbQueries: 0, dbBudgetRefused: 0, sealed: false, sealReason: null, dbInFlightAtSeal: 0,
    claimInFlightAtSeal: false, clientsDestroyed: 0, lateClientsDestroyed: 0, lateDispatchRefused: 0, readback: null, verified: false,
    tlsClientChecks: 0, tlsClientVerified: 0, tlsClientRefusal: null, backendSsl: null, source: null, detect: null };   // backendSsl = server-reported pg_stat_ssl.ssl (backend hop), never client proof
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
    const { mods, pool, credential, workerId } = input ?? {};
    if (c.dispatchEnabled !== true) return done("STOP", "HKO_DISPATCH_CLOSED");                       // before ANY acquisition
    if (parsed === null || !isObj(B)) return done("STOP", "CORE_INVALID");
    const src = parsed.source; r.source = src; const detectOnly = src === "detect";
    let binding = src === "manual" ? parsed.binding : null;                                       // "selected": derived from the snapshot below
    const need = detectOnly ? ["readKickoffFacts", "kickoffAdmission"] : ["runPipelineKickoffOnce", "readKickoffFacts", "kickoffAdmission", "createGithubWorkflowDispatch", "createGithubExchange"];
    if (!mods || need.some((k) => typeof mods[k] !== "function") || !isObj(mods.KICKOFF_SCOPE) || (!detectOnly && (!isObj(mods.KICKOFF_CONSTANTS) || !isObj(mods.GITHUB_DISPATCH_CONSTANTS)))
        || !pool || typeof pool.connect !== "function"
        || (detectOnly ? (credential !== undefined || workerId !== undefined)                          // detect: NO credential, NO worker (never claims / dispatches)
          : (typeof credential !== "function" || typeof workerId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(workerId)))) return done("STOP", "CORE_INVALID");
    // the imported consumer scope must EQUAL this runner's reviewed scope (cutoff, listing, currency, every exclusion incl. C103) — no adoption
    const S = mods.KICKOFF_SCOPE;
    if (S.cutoff !== c.scope.cutoff || S.listingId !== c.scope.listingId || S.currency !== c.scope.currency || !Array.isArray(S.excludedIntentIds)
        || c.scope.excludedIntentIds.some((id) => !S.excludedIntentIds.includes(id))) return done("STOP", "SCOPE_DRIFT");
    if (binding !== null && c.scope.excludedIntentIds.includes(binding.intentId)) return done("STOP", "HISTORICAL_TARGET");
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
        r.tlsClientChecks += 1;
        const why = clientTlsRefusal(cl, c.tls);                                                    // C112: client-hop evidence BEFORE the first statement
        if (why !== null) {
          lost = true; got = null; r.clientsDestroyed += 1; try { cl.release(true); } catch { /* contained */ }
          if (r.tlsClientRefusal === null) r.tlsClientRefusal = code(why, "EVIDENCE_ERROR");
          seal("TLS_CLIENT_UNVERIFIED"); throw new Refusal(`TLS_REQUIRED:CLIENT_${r.tlsClientRefusal}`);
        }
        r.tlsClientVerified += 1;
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
      r.backendSsl = s.tls === true ? true : s.tls === false ? false : null;
      if (s.tls !== true) return done("STOP", "TLS_REQUIRED:BACKEND_HOP");                          // C112: backend hop is still REQUIRED (no waiver)
      if (!Number.isSafeInteger(s.server_version_num) || s.server_version_num < 160000 || s.server_version_num >= 180000) return done("STOP", "SERVER_VERSION_REFUSED");
      const env = (await q(QUERIES.environment))[0];
      if (!env || env.environment !== c.environment) return done("STOP", "NOT_TEST");
      const fns = [];
      for (const p of CATALOG_PINS.functions) fns.push((await q(QUERIES.fn, [p.sig]))[0] ?? null);
      const table = (await q(QUERIES.table))[0] ?? null;
      const cw = catalogRefusal(fns, table);
      if (cw) return done("STOP", cw);
      if (src !== "manual") {
        // ---- C113: ONE read-only snapshot on ONE tracked client, inside THIS seal / deadline / counter (BEGIN + SELECT [+ facts] + ROLLBACK) ----
        let rows = null; let facts = null;
        const t = await acquire(); let ok = false;
        try {
          await tq(t, [QUERIES.snapBegin]);
          const res = await tq(t, [QUERIES.detect, [c.scope.listingId, c.scope.currency, c.scope.cutoff, [...c.scope.excludedIntentIds]]]);   // $4: the reviewed exclusions (== the consumer scope, SCOPE_DRIFT-checked); the app role has no EXECUTE on pipeline_kickoff_excluded()
          rows = res && Array.isArray(res.rows) ? res.rows : null;
          if (rows === null) throw new Refusal("DETECT_ROWS_INVALID");
          if (detectOnly && rows.length === 1) facts = await mods.readKickoffFacts({ query: (...a) => tq(t, a) }, String(rows[0].intent_id));
          await tq(t, [QUERIES.snapEnd]); ok = true;                                                  // the snapshot ends before any output
        } finally { finish(t, !ok); }                                                                  // an error destroys the client (server rolls back)
        const n = rows.length;
        if (detectOnly) {
          r.detect = { candidates: Math.min(n, 2), fingerprint: null };
          if (n === 0) return done("DETECTED", "NO_REQUEST");
          if (n > 1) return done("DETECTED", "AMBIGUOUS");
          const cand = candidateOf(rows[0]); const fp = candidateFingerprint(cand);
          if (fp === null) return done("STOP", "CANDIDATE_INVALID");
          if (c.scope.excludedIntentIds.includes(cand.intentId)) return done("DETECTED", "INELIGIBLE:HISTORICAL_TARGET");
          const why = bindingRefusal(facts, { intentId: cand.intentId, ref: cand.ref, expectedVersion: cand.version, paymentIntentId: cand.paymentIntentId,
            amountMinor: cand.amountMinor }, c);
          if (why !== null) return done("DETECTED", `INELIGIBLE:${why}`);
          const aw = mods.kickoffAdmission(facts);
          if (aw !== null) return done("DETECTED", `INELIGIBLE:${code(aw, "REFUSED")}`);
          r.detect.fingerprint = fp;
          return done("DETECTED", "ONE");                                                              // returns BEFORE any transport / credential / claim
        }
        // "selected": the decision is made at THIS snapshot; a row committed after it is not seen (stays requested for a later run)
        if (n === 0) return done("STOP", "NO_REQUEST");
        if (n > 1) return done("STOP", "AMBIGUOUS");
        const cand = candidateOf(rows[0]);
        if (candidateFingerprint(cand) !== parsed.expectedFingerprint) return done("STOP", "CANDIDATE_CHANGED");
        binding = freeze({ intentId: cand.intentId, ref: cand.ref, expectedVersion: cand.version, paymentIntentId: cand.paymentIntentId, amountMinor: cand.amountMinor,
          releaseSha: parsed.releaseSha });
        if (!manualBindingOk(binding)) return done("STOP", "SELECTED_INVALID");
        if (c.scope.excludedIntentIds.includes(binding.intentId)) return done("STOP", "HISTORICAL_TARGET");
      }
      // ---- from here the EXISTING path, unchanged (manual and selected) ----
      const t = await acquire(); let ok = false;
      try { adm = await mods.readKickoffFacts({ query: (...a) => tq(t, a) }, binding.intentId); ok = true; } finally { finish(t, !ok); }
    } catch (e) {
      if (r.tlsClientRefusal !== null) return done("STOP", `TLS_REQUIRED:CLIENT_${r.tlsClientRefusal}`);
      return done("STOP", r.sealed ? `SEALED_ADMISSION:${r.sealReason}` : `ADMISSION_READ_FAILED:${code(e && e.code, "ERR")}`);
    }
    const bw = bindingRefusal(adm, binding, c);
    if (bw !== null) return done("STOP", bw);
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
      if (r.tlsClientRefusal !== null) return done("STOP", `TLS_REQUIRED:CLIENT_${r.tlsClientRefusal}`);   // consumer client refused before its claim
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
    dispatchEnabled: c.dispatchEnabled, closureDigest: null, sourceDigest: null, pipeline: null, envCode: null, tests: null, runId: null, core: null, cleanup: null,
    flow: null, outputs: null, arm: null };
  let pool = null;
  try {
    if (!["preflight", "verify", "execute", "detect"].includes(mode)) refuse("HKO_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                                // key NAMES only — no SECRET value is read before the gates below
    const hasKey = (k) => keys.includes(k);
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("HKO_INPUT_UNEXPECTED");
    // C113: the PUBLIC workflow mode (never a binding) selects the manual or the detect flow; read only when its key is present
    const inputMode = hasKey("E7_INPUT_MODE") ? env.E7_INPUT_MODE : "";
    if (inputMode !== "" && !INPUT_MODES.includes(inputMode)) refuse("HKO_INPUT_INVALID");
    const detectFlow = mode === "detect" || (mode !== "preflight" && inputMode === "detect");
    if (mode === "detect" && inputMode !== "detect") refuse("HKO_INPUT_INVALID");
    r.flow = mode === "preflight" ? null : detectFlow ? "detect" : "manual";
    if (mode !== "preflight" && c.executeEnabled !== true) {
      // C113: detect-mode verify on a CLOSED main is a successful no-op — 0 DB-secret reads, so the gated jobs are skipped (0 approval prompts)
      if (mode === "verify" && detectFlow) {
        if (SECRET_KEYS.some(hasKey) || hasKey("E7_EXPECTED_CANDIDATE_FINGERPRINT")) refuse("HKO_SECRET_SCOPE_VIOLATION");
        if (Object.values(INPUT_ENV).some((k) => hasKey(k) && env[k] !== "")) refuse("HKO_INPUT_INVALID");   // detect accepts NO binding input
        r.code = "CLOSED_NOOP"; r.outputs = freeze({ open: "false" }); return { exitCode: 0, result: r };
      }
      refuse("HKO_EXECUTE_CLOSED");                                                                  // SHIPPED: the manual flow still refuses HERE
    }
    if (mode !== "execute" && mode !== "detect" && SECRET_KEYS.some(hasKey)) refuse("HKO_SECRET_SCOPE_VIOLATION");
    if (mode === "detect" && hasKey("E7_DISPATCH_TOKEN")) refuse("HKO_SECRET_SCOPE_VIOLATION");   // detect never holds the dispatch token
    if (hasKey("E7_EXPECTED_CANDIDATE_FINGERPRINT") && mode !== "execute") refuse("HKO_INPUT_UNEXPECTED");
    // C119 S2: the TEST arm, recomputed from THIS checkout — before any input value / tooling import / secret value / DB / token / HTTP
    let armedFrame = null;
    if (mode !== "preflight") {
      const armDir = await realpath(wrapperDir).catch(() => refuse("HKO_LAYOUT_INVALID"));
      const arm = await armDecision({ dir: armDir, value: hasKey("E7_TEST_ARM") ? env.E7_TEST_ARM : "", ref: env.GITHUB_REF });
      r.arm = arm.code;
      if (!arm.armed) {
        if (mode === "verify" && detectFlow) { r.code = "CLOSED_NOOP"; r.outputs = freeze({ open: "false" }); return { exitCode: 0, result: r }; }
        refuse("HKO_ARM_CLOSED");
      }
      armedFrame = arm.frames.kickoff;
    }
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
    if (detectFlow && anyReal) refuse("HKO_INPUT_INVALID");                                          // C113: detect mode accepts NO binding input
    // C113: the detect job's declared output reaches ONLY the execute step of the detect flow; empty / malformed → refused
    const fpIn = hasKey("E7_EXPECTED_CANDIDATE_FINGERPRINT") ? env.E7_EXPECTED_CANDIDATE_FINGERPRINT : "";
    if (mode === "execute" && detectFlow && !HEX64.test(String(fpIn))) refuse("HKO_INPUT_INVALID");
    if (mode === "execute" && !detectFlow && fpIn !== "") refuse("HKO_INPUT_INVALID");
    const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HKO_CLOSURE_MISMATCH");
      if ((!detectFlow && !anyReal) || !HEX64.test(expSrc)) refuse("HKO_INPUT_INCOMPLETE");
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
    if (mode !== "preflight" && r.sourceDigest !== armedFrame) refuse("HKO_ARM_CLOSED");            // the armed release frames THIS runner's exact bytes
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
    if (mode === "verify") { r.code = "VERIFY_OK"; if (detectFlow) r.outputs = freeze({ open: "true" }); return { exitCode: 0, result: r }; }
    // ---- execute / detect: the ONLY steps with secrets (detect: the DB secret only, never the dispatch token) ----
    r.runId = runId;
    const needed = mode === "detect" ? ["E7_DEV_BOOKING_DATABASE_URL"] : SECRET_KEYS;
    if (!needed.every((k) => typeof env[k] === "string" && env[k].length > 0)) refuse("HKO_CREDENTIALS_MISSING");
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    let tok = mode === "execute" ? env.E7_DISPATCH_TOKEN : null; delete env.E7_DISPATCH_TOKEN;
    try {
      if (mode === "execute" && !tokenShapeOk(tok)) refuse("HKO_CREDENTIAL_FORMAT_UNSUPPORTED");   // present but an unsupported shape (no value-derived detail)
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("HKO_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("HKO_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("HKO_CA_INVALID");
      let mods; try { mods = await importTooling(tooling); } catch { refuse("HKO_IMPORT_FAILED"); }
      if (!isObj(mods.PINNED_REVISION) || mods.PINNED_REVISION.sourceDigest !== REVIEWED_PIPELINE_SOURCE || mods.PINNED_REVISION.closureDigest !== c.pipeline.closureDigest) refuse("HKO_TOOLING_PIN_MISMATCH");
      try { pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: mode === "detect" ? c.detect.budgets.poolMax : c.budgets.poolMax }); } catch { refuse("HKO_DB_TARGET_INVALID"); }
      dbUrl = null;
      const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
      const t0 = tok;
      try {
        if (mode === "detect") {
          r.core = await runCore({ mods, pool, runSignal: ac.signal, constants: c, binding: { source: "detect" } });   // no credential, no worker
        } else {
          r.core = await runCore({ mods, pool, credential: () => t0, workerId: `hko:${runId}`, runSignal: ac.signal, constants: c,
            binding: detectFlow ? { source: "selected", expectedFingerprint: fpIn, releaseSha: r.workflowSha }
              : { intentId: inp.intentId, ref: inp.ref, expectedVersion: Number(inp.expectedVersion), paymentIntentId: inp.paymentIntentId,
                amountMinor: Number(inp.amountMinor), releaseSha: r.workflowSha } });
        }
      } finally { proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    } finally { dbUrl = null; tok = null; }
    if (mode === "detect") {
      const k = r.core && r.core.outcome === "DETECTED" && DETECT_OUTCOME_RE.test(String(r.core.code)) && r.core.code !== "STOP" ? r.core.code : "STOP";
      const fp = k === "ONE" && r.core.detect && HEX64.test(String(r.core.detect.fingerprint)) ? r.core.detect.fingerprint : "";
      r.code = "DETECT_DONE"; r.outputs = freeze({ outcome: k === "ONE" && fp === "" ? "STOP" : k, fingerprint: fp });
      return { exitCode: r.outputs.outcome === "STOP" ? 1 : 0, result: r };
    }
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
/** C113: the ONLY step outputs written to $GITHUB_OUTPUT (allowlisted keys + values; never an identifier) → text or "" */
export function outputLines(r) {
  const o = r && r.outputs; if (!isObj(o)) return "";
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === "open" && (v === "true" || v === "false")) out.push(`open=${v}`);
    else if (k === "outcome" && DETECT_OUTCOME_RE.test(String(v))) out.push(`outcome=${v}`);
    else if (k === "fingerprint" && (v === "" || HEX64.test(String(v)))) out.push(`fingerprint=${v}`);
    else return "";                                                                                  // anything else: write nothing
  }
  return out.length ? `${out.join("\n")}\n` : "";
}
export function summaryMarkdown(r) {
  const k = r.core ? ` core=${r.core.outcome}/${r.core.code} consumer=${r.core.consumerCode ?? "-"} gets=${r.core.gets} posts=${r.core.posts} verified=${r.core.verified === true} sealed=${r.core.sealed}` : "";
  const d = r.core && r.core.detect ? ` detect=${r.core.code} candidates=${r.core.detect.candidates}` : "";
  // C114 F1: the gate #2 reviewer must SEE the detected fingerprint to compare it with an independent recompute. Shown ONLY from the
  // runner's own validated job output (outcome ONE + 64-lowercase-hex, the value written to $GITHUB_OUTPUT); never an identifier
  const o = r.outputs; const f = o && o.outcome === "ONE" && HEX64.test(String(o.fingerprint)) ? ` candidateFingerprint=${o.fingerprint}` : "";
  return `e7-hosted-kickoff ${r.mode}${r.flow ? `/${r.flow}` : ""} ${r.code}${d}${f} executeEnabled=${r.executeEnabled} dispatchEnabled=${r.dispatchEnabled} pipelineBound=${r.pipeline ? r.pipeline.bound : "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"} cleanup=${r.cleanup ?? "-"}${k}\n`;
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("../", import.meta.url));
  runHosted({ mode, env: process.env, proc: process, wrapperDir }).then(({ exitCode, result }) => {
    const outs = outputLines(result);                                                               // C113: allowlisted job outputs only
    if (outs !== "" && typeof process.env.GITHUB_OUTPUT === "string" && process.env.GITHUB_OUTPUT.length > 0) {
      try { appendFileSync(process.env.GITHUB_OUTPUT, outs); } catch { process.exit(1); }
    }
    process.stdout.write(`${JSON.stringify({ ...result, outputs: undefined, core: result.core ? { ...result.core, detect: result.core.detect ? { candidates: result.core.detect.candidates } : null } : null })}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string" && process.env.GITHUB_STEP_SUMMARY.length > 0) {
      import("node:fs/promises").then((fs) => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result))).catch(() => {}).finally(() => process.exit(exitCode));
    } else process.exit(exitCode);
  }).catch(() => process.exit(1));
}
