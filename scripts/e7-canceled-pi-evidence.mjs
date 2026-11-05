// scripts/e7-canceled-pi-evidence.mjs — E7 R-REFUND evidence: a READ-ONLY look at ONE already-canceled Stripe TEST PaymentIntent.
//   GET /v1/account  ->  GET /v1/payment_intents/<the exact bound PI>?expand[]=latest_charge.   Nothing else, ever.
// Doc: claude/e7-canceled-pi-evidence.md. Node built-ins only. OFFLINE slice: this code is NOT consent; no manifest, workflow input, label
// or hash authorizes a provider request. execute stays CLOSED until Joel approves the exact filled package.
//   * Inert on import: no env / fs / network / timer / process access until a mode is run (`import.meta.main` guard at the bottom).
//   * Reuses the ACCEPTED tooling at the FIXED commit d1e20d71 (checked out separately): T `createE7StripeTestSend` (its GET forms only:
//     accounts.retrieve and paymentIntents.retrieve with expand latest_charge), X `createE7RealExchange` (the native exchange) and C1
//     `evaluateProbeEnvironment`. The accepted 13-path closure digest is verified BEFORE any tooling module is imported. T / X / C1 are
//     NOT modified; this file builds no request of its own.
//   * This runner's own bytes (+ its workflow + its test) form a SEPARATE review boundary: the "runner digest" below.
//   * Fixed scope (code ceiling; no account / PaymentIntent / version input exists): account acct_1TyHE42B9LTneQgw, PaymentIntent
//     pi_3UYUIm2B9LTneQgw0mGFQdwG, Stripe-Version 2026-01-28.clover (the checkout / cleanup client version), TEST key only.
//     Known baseline: canceled, manual capture, USD, amount 100 MINOR units ($1.00 TEST), received 0, capturable 0.
//   * WRITE-FREE by construction: every exchange passes ONE counted gate that admits at most TWO requests, method GET only, the two exact
//     URLs only, in order. No POST, no idempotency key, no create / capture / cancel / refund, no retry, no redirect, no pagination.
//   * Diagnostic only: it publishes what Stripe reports (amount_refunded 0 / full / partial alike) and makes NO release or state decision,
//     and no DB write. Output: whitelisted fields only; never a key, raw Stripe object, raw error, header, URL, card / guest / customer
//     data, client_secret or refund object.
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, appendFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONSTANTS = Object.freeze({
  toolingCommit: "d1e20d71ecf15f82d2d3b74fd22eb562eaa310f8",
  sourceDigest: "23212caabf508f0aa929a2c3beb9f6f216b0cc3bc697cd783ba7ed203e21ce3d",
  sourceClosure: Object.freeze(["package.json", "scripts/e7-connected/probe-cli-main.mjs", "scripts/e7-connected/probe-source-digest.mjs",
    "scripts/e7-connected/probe-command.mjs", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-credential-file.mjs",
    "scripts/e7-connected/readonly-probe.mjs", "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs",
    "lib/checkout/compensation-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/capture-proof.js", "lib/checkout/intent-state.js"]),
  runnerFiles: Object.freeze(["scripts/e7-canceled-pi-evidence.mjs", ".github/workflows/e7-canceled-pi-evidence.yml", "test/e7-canceled-pi-evidence.test.mjs"]),
  accountId: "acct_1TyHE42B9LTneQgw",
  paymentIntentId: "pi_3UYUIm2B9LTneQgw0mGFQdwG",
  stripeVersion: "2026-01-28.clover",               // = CHECKOUT_STRIPE_API_VERSION / WEBHOOK_STRIPE_API_VERSION of the checkout + cleanup clients
  baseline: Object.freeze({ status: "canceled", captureMethod: "manual", currency: "usd", amount: 100, amountReceived: 0, amountCapturable: 0,
    purpose: "e7-authorization-test" }),          // amount in MINOR units: 100 = $1.00 TEST
  maxExchanges: 2,
  perCallMs: 15000,
  nodeVersion: "22.22.0",
  synthetic: Object.freeze({ approvalRef: "SYNTHETIC-preflight-not-for-execute" })
});
export const PLAN_SCHEMA = "e7-canceled-pi-evidence-plan-v1";
export const RESULT_SCHEMA = "e7-canceled-pi-evidence-result-v1";
export const OUTCOMES = Object.freeze(["EVIDENCE_CAPTURED", "STOPPED_BEFORE_REQUEST", "ACCOUNT_MISMATCH", "ACCOUNT_UNKNOWN", "PI_READ_FAILED",
  "PI_NOT_BOUND", "PI_LIVEMODE_REFUSED", "PI_BASELINE_MISMATCH", "CHARGE_MISSING", "CHARGE_NOT_EXPANDED", "CHARGE_NOT_BOUND", "CHARGE_FIELDS_INVALID", "CORE_INVALID"]);
export const CHARGE_STATUSES = Object.freeze(["succeeded", "pending", "failed"]);
export const REFUNDED_CLASSES = Object.freeze(["ZERO", "FULL", "PARTIAL"]);
export const HOSTED_CODES = Object.freeze(["EVID_USAGE", "EVID_SECRET_SCOPE_VIOLATION", "EVID_INPUT_INVALID", "EVID_INPUT_INCOMPLETE", "EVID_REF_NOT_MAIN",
  "EVID_LAYOUT_INVALID", "EVID_SOURCE_UNREADABLE", "EVID_SOURCE_MISMATCH", "EVID_RUNNER_MISMATCH", "EVID_PLAN_HASH_MISMATCH", "EVID_ENV_REFUSED",
  "EVID_TESTS_FAILED", "EVID_CHILD_FAILED", "EVID_IMPORT_FAILED", "EVID_CREDENTIALS_MISSING", "EVID_INTERNAL",
  "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const CH_RE = /^ch_[A-Za-z0-9_]{1,250}$/;
const MAX_FILE = 262144; const MAX_TOTAL = 2097152;
const STRIPE = "https://api.stripe.com";
const freeze = Object.freeze;

class Refusal extends Error { constructor(code) { super("e7-canceled-pi-evidence"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };

// =================================================================================================================================
// plan (pure)
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** canonical JSON (sorted keys) */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
/** the ONLY two requests this runner can make, in order (method + exact URL) */
export function plannedRequests(c) {
  return freeze([freeze({ op: "accounts.retrieve", method: "GET", url: `${STRIPE}/v1/account` }),
    freeze({ op: "paymentIntents.retrieve", method: "GET", url: `${STRIPE}/v1/payment_intents/${c.paymentIntentId}?expand%5B%5D=latest_charge` })]);
}
/** buildPlan(c, { approvalRef, runnerDigest }) → frozen { plan, planHash }. Refuses malformed identity or a widened ceiling. */
export function buildPlan(c, { approvalRef, runnerDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("EVID_INPUT_INVALID");
  if (c.maxExchanges !== 2 || c.accountId !== "acct_1TyHE42B9LTneQgw" || c.paymentIntentId !== "pi_3UYUIm2B9LTneQgw0mGFQdwG"
      || c.stripeVersion !== "2026-01-28.clover" || c.baseline.amount !== 100 || c.baseline.currency !== "usd") refuse("EVID_INPUT_INVALID");   // code ceiling
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, sourceDigest: c.sourceDigest, runnerDigest, stripeVersion: c.stripeVersion,
    accountId: c.accountId, paymentIntentId: c.paymentIntentId, baseline: { ...c.baseline }, approvalRef, maxExchanges: c.maxExchanges, perCallMs: c.perCallMs,
    requests: plannedRequests(c).map((r) => `${r.method} ${r.url}`), writes: 0, decision: "NONE" };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)) });
}
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

// =================================================================================================================================
// core (injected; no native I/O of its own)
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const nni = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * runEvidenceCore({ plan, exchange, credential, createStripeSend, makeCallSignal?, runSignal? }) → frozen public result. Never throws.
 *   exchange(request) → native Promise<{ status, contentType, bytes }>   (accepted X exchange, or a FAKE in tests)
 *   createStripeSend = accepted T `createE7StripeTestSend`, constructed HERE over the counted GET-only gate.
 *   credential() → the TEST key (sync; read by T per send; never stored in the result).
 */
export async function runEvidenceCore(input) {
  const c = CONSTANTS;
  const r = { schema: RESULT_SCHEMA, outcome: null, exchanges: 0, writesSent: 0, stripeVersion: c.stripeVersion, decision: "NONE", account: "NOT_RUN",
    paymentIntent: null, charge: null, refundedClass: null, chargeBaseline: null };
  const done = (outcome) => { r.outcome = outcome; return freeze(JSON.parse(JSON.stringify(r))); };
  let count = 0; let lastSent = false;
  try {
    const { plan, exchange, credential, createStripeSend } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.paymentIntentId !== c.paymentIntentId || plan.stripeVersion !== c.stripeVersion
        || plan.maxExchanges !== c.maxExchanges || plan.writes !== 0 || typeof exchange !== "function" || typeof credential !== "function"
        || typeof createStripeSend !== "function") return done("CORE_INVALID");
    const makeSignal = typeof input.makeCallSignal === "function" ? input.makeCallSignal : () => AbortSignal.timeout(c.perCallMs);
    const runSignal = input.runSignal ?? null;
    const allowed = plannedRequests(c);
    // ---- the ONE gate every exchange passes: budget 2, GET only, the exact planned URL in order, fixed header set + version -------------
    const gate = (req) => {
      const want = allowed[count];
      if (!want || !isObj(req) || req.method !== "GET" || req.url !== want.url || req.body !== null || !isObj(req.headers)
          || Object.keys(req.headers).sort().join(",") !== "Authorization,Stripe-Version" || req.headers["Stripe-Version"] !== c.stripeVersion) {
        return Promise.reject(new Error("gate"));                                   // never sent: not counted as an exchange
      }
      count += 1; r.exchanges = count; lastSent = true;
      return exchange(req);
    };
    const t = createStripeSend({ exchange: gate, credential, accountId: c.accountId, apiVersion: c.stripeVersion });
    if (!t || t.ok !== true) return done("CORE_INVALID");
    const send = async (call) => { lastSent = false; return t.transport.send(call, { signal: makeSignal() }); };
    const tCode = (e) => (e && typeof e.code === "string" ? e.code : "UNKNOWN");

    // ---- (1) GET /v1/account: the credential's account must be exactly the configured TEST account -------------------------------------
    if (runSignal && runSignal.aborted) return done("STOPPED_BEFORE_REQUEST");
    try { await send({ op: "accounts.retrieve" }); r.account = "OK"; }
    catch (e) {
      if (tCode(e) === "ACCOUNT_MISMATCH") { r.account = "MISMATCH"; return done("ACCOUNT_MISMATCH"); }
      r.account = lastSent ? "UNKNOWN" : "NOT_SENT";
      return done(lastSent ? "ACCOUNT_UNKNOWN" : "STOPPED_BEFORE_REQUEST");
    }
    if (runSignal && runSignal.aborted) return done("STOPPED_BEFORE_REQUEST");

    // ---- (2) GET the exact PaymentIntent with its latest charge expanded -------------------------------------------------------------------
    let pi;
    try { pi = await send({ op: "paymentIntents.retrieve", id: c.paymentIntentId, params: { expand: ["latest_charge"] } }); }
    catch (e) { return done(tCode(e) === "LIVEMODE_REFUSED" ? "PI_LIVEMODE_REFUSED" : "PI_READ_FAILED"); }   // T already checked object + exact id
    if (!isObj(pi) || pi.object !== "payment_intent" || pi.id !== c.paymentIntentId || pi.livemode !== false) return done("PI_NOT_BOUND");
    const b = c.baseline; const md = own(pi, "metadata");
    if (pi.capture_method !== b.captureMethod || pi.currency !== b.currency || pi.amount !== b.amount || !isObj(md) || md.e7_purpose !== b.purpose) return done("PI_NOT_BOUND");
    if (pi.status !== b.status || pi.amount_received !== b.amountReceived || pi.amount_capturable !== b.amountCapturable) return done("PI_BASELINE_MISMATCH");
    // ---- the bound latest charge: expanded, TEST, bound to this PI, typed fields only ------------------------------------------------------
    const lc = own(pi, "latest_charge");
    if (lc === null || lc === undefined) return done("CHARGE_MISSING");
    if (!isObj(lc)) return done("CHARGE_NOT_EXPANDED");
    if (lc.object !== "charge" || typeof lc.id !== "string" || !CH_RE.test(lc.id) || lc.payment_intent !== c.paymentIntentId || lc.livemode !== false) return done("CHARGE_NOT_BOUND");
    if (!CHARGE_STATUSES.includes(lc.status) || lc.currency !== b.currency || lc.amount !== b.amount || typeof lc.captured !== "boolean" || !nni(lc.amount_captured)
        || !nni(lc.amount_refunded) || lc.amount_refunded > lc.amount || lc.amount_captured > lc.amount || typeof lc.refunded !== "boolean") return done("CHARGE_FIELDS_INVALID");
    // ---- whitelisted evidence (copied scalars only) ---------------------------------------------------------------------------------------
    r.paymentIntent = { id: pi.id, status: pi.status, captureMethod: pi.capture_method, currency: pi.currency, amount: pi.amount, amountReceived: pi.amount_received,
      amountCapturable: pi.amount_capturable };
    r.charge = { id: lc.id, status: lc.status, currency: lc.currency, amount: lc.amount, captured: lc.captured, amountCaptured: lc.amount_captured,
      amountRefunded: lc.amount_refunded, refunded: lc.refunded };
    // descriptive only: NOT a release proof and NOT a decision (decision stays "NONE")
    r.refundedClass = lc.amount_refunded === 0 ? "ZERO" : lc.amount_refunded === lc.amount ? "FULL" : "PARTIAL";
    r.chargeBaseline = lc.captured === false && lc.amount_captured === 0 ? "NEVER_CAPTURED" : "CAPTURE_REPORTED";
    return done("EVIDENCE_CAPTURED");
  } catch {
    r.exchanges = count;
    return done("CORE_INVALID");
  }
}

// =================================================================================================================================
// hosted wiring (gated; real fs / child / native https only inside runHosted with the real deps)
/** framed SHA-256 (same recipe as the accepted helper / hosted wrappers) over regular files, no symlink, bounded */
export async function framedDigest(dir, files, prefix = "e7-probe-source-v1\n") {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("EVID_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("EVID_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("EVID_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const RUNNER_DIGEST_PREFIX = "e7-canceled-pi-evidence-runner-v1\n";
/** the preflight child's env: job env minus every E7_* key, plus the (non-secret) tooling dir */
export function childEnv(env, toolingDir) { const out = {}; for (const k of Object.keys(env)) if (!k.startsWith("E7_")) out[k] = env[k]; out.E7_TOOLING_DIR = toolingDir; return out; }
export function spawnNode(args, { cwd, env }) {
  return new Promise((resolve) => {
    let out = ""; let outBytes = 0; let truncated = false; let child;
    try { child = spawn(process.execPath, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "ignore"] }); } catch { resolve({ status: null, signal: null, stdout: "", truncated: false, spawnFailed: true }); return; }
    child.stdout.on("data", (d) => { outBytes += d.length; if (outBytes <= 262144) out += d.toString("utf8"); else truncated = true; });
    child.on("error", () => resolve({ status: null, signal: null, stdout: "", truncated, spawnFailed: true }));
    child.on("close", (status, signal) => resolve({ status, signal, stdout: out, truncated, spawnFailed: false }));
  });
}
const TEST_FILE = "test/e7-canceled-pi-evidence.test.mjs";

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws.
 *   deps (TEST SEAMS, real ones by default): spawnChild, importTooling(dir) → { T, X, C1 }, runCore, constants.
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runEvidenceCore;
  const r = { schema: "e7-canceled-pi-evidence-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, sourceDigest: null, runnerDigest: null,
    planKind: null, planHash: null, envCode: null, tests: null, core: null };
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("EVID_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasKey = typeof env.E7_STRIPE_TEST_KEY === "string" && env.E7_STRIPE_TEST_KEY.length > 0;
    if (mode !== "execute" && hasKey) refuse("EVID_SECRET_SCOPE_VIOLATION");
    if (Object.keys(env).some((k) => /HOSTAWAY/i.test(k))) refuse("EVID_SECRET_SCOPE_VIOLATION");            // no Hostaway secret / input in this job
    const ref = env.E7_APPROVAL_REF ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    if (ref !== "" && !APPROVAL_RE.test(ref)) refuse("EVID_INPUT_INVALID");
    if (ref === c.synthetic.approvalRef) refuse("EVID_INPUT_INVALID");                                       // synthetic never qualifies a real package
    let real;
    if (mode === "preflight") real = ref !== "";
    else {
      if (ref === "" || !HEX64.test(expPlan) || !HEX64.test(expSrc) || !HEX64.test(expRun)) refuse("EVID_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("EVID_REF_NOT_MAIN");
      if (expSrc !== c.sourceDigest) refuse("EVID_SOURCE_MISMATCH");
      real = true;
    }
    // ---- layout + (1) accepted 13-path closure BEFORE importing any tooling module ---------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("EVID_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("EVID_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("EVID_LAYOUT_INVALID");
    r.sourceDigest = await framedDigest(tooling, c.sourceClosure).catch((e) => refuse(e instanceof Refusal ? e.code : "EVID_SOURCE_UNREADABLE"));
    if (r.sourceDigest !== c.sourceDigest) refuse("EVID_SOURCE_MISMATCH");
    // ---- (2) this runner's own boundary (independent of the accepted closure) ----------------------------------------------------
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "EVID_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("EVID_RUNNER_MISMATCH");
    // ---- (3) plan: binds the reviewed approval label + digests to the exact two GETs -----------------------------------------------
    r.planKind = real ? "REAL" : "SYNTHETIC";
    const built = buildPlan(c, { approvalRef: real ? ref : c.synthetic.approvalRef, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("EVID_PLAN_HASH_MISMATCH");
    // ---- (4) accepted modules (digest verified above) + env evaluation -----------------------------------------------------------
    let mods; try { mods = await importTooling(tooling); } catch { refuse("EVID_IMPORT_FAILED"); }
    const present = Object.fromEntries(mods.C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = mods.C1.evaluateProbeEnvironment({ schema: mods.C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && mods.C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("EVID_ENV_REFUSED");
    // ---- (5) preflight: the FAKE test suite as a plain child (no secrets, no provider, no network) ------------------------------------
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("EVID_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("EVID_TESTS_FAILED");
      r.code = real ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- (6) execute: the ONLY step that sees the TEST key; read once, removed from process env ----------------------------------------
    if (!hasKey) refuse("EVID_CREDENTIALS_MISSING");
    let key = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    const credential = () => key;
    const ex = mods.X.createE7RealExchange({ provider: "stripe" });
    if (!ex || ex.ok !== true) refuse("EVID_IMPORT_FAILED");
    const ac = new AbortController();
    const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try { r.core = await runCore({ plan: built.plan, exchange: ex.exchange, credential, createStripeSend: mods.T.createE7StripeTestSend, runSignal: ac.signal }); }
    finally { key = null; proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "EVIDENCE_CAPTURED" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "EVID_INTERNAL";
    return { exitCode: 1, result: r };
  }
}
async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [T, X, C1] = await Promise.all([import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")),
    import(u("scripts/e7-connected/probe-env-preflight.mjs"))]);
  return { T, X, C1 };
}
/** markdown job summary from the whitelisted result only */
export function summaryMarkdown(r) {
  const k = r.core; const p = k && k.paymentIntent; const ch = k && k.charge;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["sourceDigest (computed)", r.sourceDigest],
    ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["planHash", r.planHash], ["env", r.envCode],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["outcome", k ? k.outcome : null], ["exchanges / writes", k ? `${k.exchanges} / ${k.writesSent}` : null], ["Stripe-Version", k ? k.stripeVersion : null],
    ["account", k ? k.account : null],
    ["PaymentIntent", p ? `${p.id} ${p.status} ${p.captureMethod} ${p.currency} amount ${p.amount} received ${p.amountReceived} capturable ${p.amountCapturable}` : null],
    ["charge", ch ? `${ch.id} ${ch.status} ${ch.currency} amount ${ch.amount} captured ${ch.captured} amount_captured ${ch.amountCaptured}` : null],
    ["charge amount_refunded / refunded", ch ? `${ch.amountRefunded} / ${ch.refunded} (${k.refundedClass}; descriptive only)` : null],
    ["decision", k ? k.decision : null]];
  return `### E7 canceled TEST PaymentIntent — read-only evidence\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
