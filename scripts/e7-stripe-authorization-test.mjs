// scripts/e7-stripe-authorization-test.mjs — E7 path A: bounded Stripe-TEST-only authorization rehearsal
//   account check -> ONE create (manual capture, confirm) -> ONE retrieve (expand latest_charge) -> ONE cancel -> ONE final retrieve.
// Doc / request + cleanup map: claude/e7-stripe-authorization-test.md. Node built-ins only. OFFLINE slice: this code is NOT consent and no
// manifest, workflow input, label or hash authorizes a provider write; execute stays CLOSED until Joel approves the exact filled package.
//   * Inert on import: no env / fs / network / timer / process access until a mode is run (`import.meta.main` guard at the bottom).
//   * Reuses the ACCEPTED tooling at the FIXED commit d1e20d71 (checked out separately): T `createE7StripeTestSend` (account read, PI
//     retrieve, PI cancel), X `createE7RealExchange` (the one exact create POST, built HERE — T is not broadened) and C1
//     `evaluateProbeEnvironment`. The accepted 13-path closure digest is verified BEFORE any tooling module is imported.
//   * This runner's own bytes (+ its workflow + its test) form a SEPARATE review boundary: the "runner digest" below. The accepted 13-path
//     digest does NOT cover this code.
//   * Fixed scope: amount 100 (USD minor = $1.00 TEST), currency usd, account acct_1TyHE42B9LTneQgw, payment method literal pm_card_visa
//     (Stripe TEST PaymentMethod, no card data), capture_method=manual, confirm=true, card only. No amount / currency / account /
//     payment-method input exists. No capture operation exists in this file. No DB, webhook, Hostaway, email, Vercel.
//   * Budget: at most FIVE provider exchanges, counted at the exchange layer; no retry, no new idempotency key, no extra call after a
//     failure beyond the predeclared map; run identity (run_ref -> idempotency keys + metadata) is an explicit reviewed input, never generated.
//   * Output: whitelisted fields only (fixed code sets, PI status set, safe integers, the bound PI id). Never a key, raw Stripe object, raw
//     error, client_secret, header or URL.
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
  runnerFiles: Object.freeze(["scripts/e7-stripe-authorization-test.mjs", ".github/workflows/e7-stripe-authorization-test.yml",
    "test/e7-stripe-authorization-test.test.mjs"]),
  accountId: "acct_1TyHE42B9LTneQgw",
  amount: 100,                                    // USD minor units = $1.00; the ONLY amount this code can send
  currency: "usd",
  paymentMethod: "pm_card_visa",                  // Stripe TEST PaymentMethod literal (docs.stripe.com/testing): no card number anywhere
  stripeVersion: "2026-08-26.dahlia",             // = the accepted run #6 / hosted read-only probe version; no upgrade
  purpose: "e7-authorization-test",
  maxExchanges: 5,
  perCallMs: 15000,
  nodeVersion: "22.22.0",
  synthetic: Object.freeze({ runRef: "SYNTHETIC-preflight-only", approvalRef: "SYNTHETIC-preflight-not-for-execute" })
});
export const PLAN_SCHEMA = "e7-stripe-auth-plan-v1";
export const RESULT_SCHEMA = "e7-stripe-auth-result-v1";
export const PI_STATUSES = Object.freeze(["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"]);
/** final outcome codes (core) */
export const OUTCOMES = Object.freeze(["AUTH_TEST_COMPLETED_OK", "AUTH_TEST_COMPLETED_PROOF_INCOMPLETE", "AUTH_TEST_AUTHORIZATION_NOT_VERIFIED",
  "STOPPED_BEFORE_CREATE", "CREATE_REFUSED", "CREATE_UNKNOWN", "CREATE_UNBOUND", "IDENTITY_CONFLICT", "CAPTURED_UNEXPECTED", "NOT_CANCELLABLE",
  "CLEANUP_NOT_DONE", "CLEANUP_UNKNOWN", "CLEANUP_NOT_VERIFIED", "CORE_INVALID"]);
export const STEP_CODES = Object.freeze(["OK", "NOT_RUN", "NOT_SENT", "REFUSED", "UNKNOWN", "MISMATCH", "UNBOUND", "CANCELED", "UNEXPECTED_STATUS", "SKIPPED_ALREADY_CANCELED"]);
/** hosted (CLI) codes */
export const HOSTED_CODES = Object.freeze(["AUTH_USAGE", "AUTH_SECRET_SCOPE_VIOLATION", "AUTH_INPUT_INVALID", "AUTH_INPUT_INCOMPLETE", "AUTH_REF_NOT_MAIN",
  "AUTH_LAYOUT_INVALID", "AUTH_SOURCE_UNREADABLE", "AUTH_SOURCE_MISMATCH", "AUTH_RUNNER_MISMATCH", "AUTH_PLAN_HASH_MISMATCH", "AUTH_ENV_REFUSED",
  "AUTH_TESTS_FAILED", "AUTH_CHILD_FAILED", "AUTH_IMPORT_FAILED", "AUTH_CREDENTIALS_MISSING", "AUTH_INTERNAL",
  "PREFLIGHT_OK_REAL_PLAN", "PREFLIGHT_OK_SYNTHETIC_ONLY", "VERIFY_OK", "EXECUTE_DONE"]);

const RUN_REF_RE = /^[A-Za-z0-9-]{8,64}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const CH_RE = /^ch_[A-Za-z0-9_]{1,250}$/;
const TEST_KEY_RE = /^sk_test_[A-Za-z0-9]{1,247}$/;          // = accepted T's TEST rule; enforced again here before the create POST
const MAX_REPLY = 256 * 1024; const MAX_FILE = 262144; const MAX_TOTAL = 2097152;
const freeze = Object.freeze;

class Refusal extends Error { constructor(code) { super("e7-stripe-auth"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };

// =================================================================================================================================
// plan (pure)
/** the exact create form body: fixed order, fixed values; only run_ref varies (validated, URL-safe, never encoded differently) */
export function createBody(c, runRef) {
  return `amount=${c.amount}&currency=${c.currency}&capture_method=manual&confirm=true&payment_method=${c.paymentMethod}`
    + `&allowed_payment_method_types%5B%5D=card&metadata%5Be7_purpose%5D=${c.purpose}&metadata%5Be7_run_ref%5D=${runRef}`;
}
const keysFor = (runRef) => ({ create: `e7-auth-${runRef}-create`, cancel: `e7-auth-${runRef}-cancel` });
const sha = (s) => createHash("sha256").update(s).digest("hex");
/** canonical JSON (sorted keys) */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
/** buildPlan(c, { runRef, approvalRef, runnerDigest }) → frozen plan + planHash. Refuses malformed identity. */
export function buildPlan(c, { runRef, approvalRef, runnerDigest }) {
  if (typeof runRef !== "string" || !RUN_REF_RE.test(runRef) || typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef)) refuse("AUTH_INPUT_INVALID");
  if (c.amount !== 100 || c.currency !== "usd" || c.paymentMethod !== "pm_card_visa" || c.maxExchanges !== 5) refuse("AUTH_INPUT_INVALID");   // code ceiling
  const k = keysFor(runRef); const body = createBody(c, runRef);
  const plan = { schema: PLAN_SCHEMA, toolingCommit: c.toolingCommit, sourceDigest: c.sourceDigest, runnerDigest, stripeVersion: c.stripeVersion,
    accountId: c.accountId, amount: c.amount, currency: c.currency, paymentMethod: c.paymentMethod, captureMethod: "manual", confirm: true,
    allowedPaymentMethodTypes: ["card"], runRef, approvalRef, createIdempotencyKey: k.create, cancelIdempotencyKey: k.cancel,
    metadata: { e7_purpose: c.purpose, e7_run_ref: runRef }, createBodySha256: sha(body), maxExchanges: c.maxExchanges, perCallMs: c.perCallMs,
    operations: ["accounts.retrieve", "paymentIntents.create", "paymentIntents.retrieve", "paymentIntents.cancel", "paymentIntents.retrieve"] };
  return freeze({ plan: deepFreeze(plan), planHash: sha(canonical(plan)), body });
}
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

// =================================================================================================================================
// core (injected; no native I/O of its own)
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const nni = (v) => Number.isSafeInteger(v) && v >= 0;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const metaExact = (m, runRef, c) => isObj(m) && Object.keys(m).length === 2 && m.e7_purpose === c.purpose && m.e7_run_ref === runRef;
/** the fields that bind a PaymentIntent to THIS run (beyond T's object / id / livemode checks) */
function boundPi(pi, id, runRef, c) {
  return isObj(pi) && pi.object === "payment_intent" && pi.id === id && pi.livemode === false && pi.amount === c.amount && pi.currency === c.currency
    && pi.capture_method === "manual" && metaExact(pi.metadata, runRef, c);
}
const statusOf = (pi) => (isObj(pi) && PI_STATUSES.includes(pi.status) ? pi.status : null);
/** authorization verification of a requires_capture PI (expanded latest_charge). → { verdict, proofFields, captureBefore, conflict } */
function verifyAuthorization(pi, id, c) {
  const out = { verdict: "NOT_VERIFIED", proofFields: "NOT_CHECKED", captureBefore: null, conflict: false };
  if (pi.amount_capturable !== c.amount || pi.amount_received !== 0) return out;
  const lc = own(pi, "latest_charge");
  if (!isObj(lc)) return out;                                              // null / string id / other: charge unverified
  if (lc.livemode !== false) { out.conflict = true; return out; }          // a non-TEST charge on a TEST PI: contradiction
  if (lc.object !== "charge" || typeof lc.id !== "string" || !CH_RE.test(lc.id) || lc.payment_intent !== id || lc.captured !== false
      || lc.amount_captured !== 0 || lc.amount !== c.amount || lc.currency !== c.currency || lc.amount_refunded !== 0 || typeof lc.paid !== "boolean") return out;
  // R-PC3 rule (accepted read-only probe): payment_method_details.card.capture_before positive int = COMPLETE; absent / null = INCOMPLETE;
  // present but invalid = INVALID (reported, authorization NOT verified, cleanup still runs on the bound identity)
  const absent = (v) => v === undefined || v === null;
  const incomplete = () => { out.proofFields = "INCOMPLETE"; out.verdict = "VERIFIED"; return out; };
  const invalid = () => { out.proofFields = "INVALID"; return out; };
  const pmd = own(lc, "payment_method_details");
  if (absent(pmd)) return incomplete();
  if (!isObj(pmd)) return invalid();
  const card = own(pmd, "card");
  if (absent(card)) return incomplete();
  if (!isObj(card)) return invalid();
  const cb = own(card, "capture_before");
  if (absent(cb)) return incomplete();
  if (!posInt(cb)) return invalid();
  out.proofFields = "COMPLETE"; out.captureBefore = cb; out.verdict = "VERIFIED"; return out;
}
/** bounded JSON of the create reply (fatal UTF-8, ≤ 256 KiB) → value | undefined */
function parseReply(bytes) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_REPLY) return undefined;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return undefined; }
}
const DEFINITELY_NOT_SENT_T = ["OPTIONS_INVALID", "REQUEST_NOT_ALLOWED", "CREDENTIAL_INVALID", "KEY_NOT_TEST"];

/**
 * runAuthorizationCore({ plan, body, exchange, credential, createStripeSend, makeCallSignal?, runSignal? }) → frozen public result. Never throws.
 *   exchange(request) → native Promise<{ status, contentType, bytes }>   (accepted X exchange, or a FAKE in tests)
 *   createStripeSend = accepted T `createE7StripeTestSend`; it is constructed HERE over the same COUNTED exchange.
 *   credential() → the TEST key (sync; called by T per send and once here for the create header; never stored in the result).
 */
export async function runAuthorizationCore(input) {
  const r = { schema: RESULT_SCHEMA, outcome: null, exchanges: 0, writesSent: 0, runRef: null, createIdempotencyKey: null, cancelIdempotencyKey: null,
    paymentIntentId: null, account: "NOT_RUN", create: { step: "NOT_RUN", httpStatus: null, status: null },
    retrieve: { step: "NOT_RUN", status: null, authorization: "NOT_CHECKED", proofFields: "NOT_CHECKED", captureBefore: null },
    cancel: { step: "NOT_RUN" }, final: { step: "NOT_RUN", status: null, amountReceived: null, amountCapturable: null }, cleanup: "NOT_APPLICABLE", residual: "NONE" };
  const done = (outcome, residual) => { r.outcome = outcome; if (residual) r.residual = residual; return freeze(JSON.parse(JSON.stringify(r))); };
  let count = 0; let lastSent = false;
  try {
    const { plan, body, exchange, credential, createStripeSend } = input ?? {};
    const c = CONSTANTS;
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.accountId !== c.accountId || plan.amount !== c.amount || plan.currency !== c.currency
        || plan.paymentMethod !== c.paymentMethod || plan.stripeVersion !== c.stripeVersion || typeof body !== "string" || body !== createBody(c, plan.runRef)
        || plan.createBodySha256 !== sha(body) || typeof exchange !== "function" || typeof credential !== "function" || typeof createStripeSend !== "function") return done("CORE_INVALID");
    const runRef = plan.runRef; r.runRef = runRef; r.createIdempotencyKey = plan.createIdempotencyKey; r.cancelIdempotencyKey = plan.cancelIdempotencyKey;
    const makeSignal = typeof input.makeCallSignal === "function" ? input.makeCallSignal : () => AbortSignal.timeout(c.perCallMs);
    const runSignal = input.runSignal ?? null;
    // ---- the budget lives at the exchange layer: every provider exchange (T's and the create) passes here -----------------------------
    const counted = (req) => {
      if (count >= c.maxExchanges) return Promise.reject(new Error("budget"));   // never reached by the map below; defence only
      count += 1; r.exchanges = count; lastSent = true;
      return exchange(req);
    };
    const t = createStripeSend({ exchange: counted, credential, accountId: c.accountId, apiVersion: c.stripeVersion });
    if (!t || t.ok !== true) return done("CORE_INVALID");
    const send = async (call) => { lastSent = false; return t.transport.send(call, { signal: makeSignal() }); };
    const tCode = (e) => (e && typeof e.code === "string" ? e.code : "UNKNOWN");
    const retrieveCall = (id) => ({ op: "paymentIntents.retrieve", id, params: { expand: ["latest_charge"] } });

    // ---- (1) account check BEFORE any write ----------------------------------------------------------------------------------------
    if (runSignal && runSignal.aborted) return done("STOPPED_BEFORE_CREATE");
    try { await send({ op: "accounts.retrieve" }); r.account = "OK"; }
    catch (e) { r.account = tCode(e) === "ACCOUNT_MISMATCH" ? "MISMATCH" : lastSent ? "UNKNOWN" : "NOT_SENT"; return done("STOPPED_BEFORE_CREATE"); }
    if (runSignal && runSignal.aborted) return done("STOPPED_BEFORE_CREATE");          // operator abort observed before the only create

    // ---- (2) ONE create: exact fixed form via X; never retried, never re-keyed --------------------------------------------------------
    let key = credential();
    if (typeof key !== "string" || !TEST_KEY_RE.test(key)) { key = null; r.create.step = "NOT_SENT"; return done("STOPPED_BEFORE_CREATE"); }
    const req = freeze({ method: "POST", url: "https://api.stripe.com/v1/payment_intents",
      headers: freeze({ Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": plan.createIdempotencyKey, "Stripe-Version": c.stripeVersion }),
      body, signal: makeSignal(), maxBytes: MAX_REPLY });
    key = null;
    lastSent = false; r.writesSent += 1;
    let reply;
    try { reply = await counted(req); }
    catch (e) {
      if (e && e.code === "EXCHANGE_INPUT_INVALID") { r.writesSent -= 1; r.create.step = "NOT_SENT"; return done("STOPPED_BEFORE_CREATE"); }   // refused before any socket
      r.create.step = "UNKNOWN"; return done("CREATE_UNKNOWN", "POSSIBLE_PI_UNKNOWN_IDENTITY");
    }
    const st = reply && Number.isSafeInteger(reply.status) ? reply.status : null;
    r.create.httpStatus = st !== null && st >= 100 && st <= 599 ? st : null;
    if (st === null || st < 200 || (st >= 300 && st < 400) || st >= 500) { r.create.step = "UNKNOWN"; return done("CREATE_UNKNOWN", "POSSIBLE_PI_UNKNOWN_IDENTITY"); }
    if (st >= 400) { r.create.step = "REFUSED"; return done("CREATE_REFUSED", "POSSIBLE_UNAUTHORIZED_PI_NO_HOLD"); }   // raw error never parsed / published
    const pi = parseReply(reply.bytes);
    const piId = isObj(pi) && typeof pi.id === "string" && PI_RE.test(pi.id) ? pi.id : null;
    if (piId === null || !boundPi(pi, piId, runRef, c) || statusOf(pi) === null) { r.create.step = "UNBOUND"; return done("CREATE_UNBOUND", "POSSIBLE_PI_UNKNOWN_IDENTITY"); }
    r.paymentIntentId = piId; r.create.step = "OK"; r.create.status = statusOf(pi);

    // ---- (3) ONE retrieve (expanded latest_charge) ------------------------------------------------------------------------------------
    let decisionStatus = r.create.status;
    try {
      const got = await send(retrieveCall(piId));
      if (!boundPi(got, piId, runRef, c) || statusOf(got) === null) { r.retrieve.step = "MISMATCH"; return done("IDENTITY_CONFLICT", "BOUND_PI_NOT_CANCELLED"); }
      r.retrieve.step = "OK"; r.retrieve.status = decisionStatus = statusOf(got);
      if (decisionStatus === "requires_capture") {
        const v = verifyAuthorization(got, piId, c);
        if (v.conflict) { r.retrieve.step = "MISMATCH"; return done("IDENTITY_CONFLICT", "BOUND_PI_NOT_CANCELLED"); }
        r.retrieve.authorization = v.verdict; r.retrieve.proofFields = v.proofFields; r.retrieve.captureBefore = v.captureBefore;
      }
    } catch (e) {
      const code = tCode(e);
      if (code === "LIVEMODE_REFUSED") { r.retrieve.step = "MISMATCH"; return done("IDENTITY_CONFLICT", "BOUND_PI_NOT_CANCELLED"); }   // never write against a live-looking object
      r.retrieve.step = !lastSent && DEFINITELY_NOT_SENT_T.includes(code) ? "NOT_SENT" : code === "STRIPE_HTTP_4XX" ? "REFUSED" : "UNKNOWN";
      // identity stays bound by the create reply: decide on the create status (predeclared map)
    }
    if (decisionStatus === "succeeded") return done("CAPTURED_UNEXPECTED", "TEST_CHARGE_CAPTURED_NEEDS_OPERATOR");
    if (decisionStatus === "processing") return done("NOT_CANCELLABLE", "BOUND_PI_PROCESSING_NOT_CANCELLED");
    if (decisionStatus === "canceled") { r.cancel.step = "SKIPPED_ALREADY_CANCELED"; r.cleanup = r.retrieve.step === "OK" ? "VERIFIED" : "NOT_VERIFIED";
      return done(r.retrieve.step === "OK" ? "AUTH_TEST_AUTHORIZATION_NOT_VERIFIED" : "CLEANUP_NOT_VERIFIED", r.retrieve.step === "OK" ? "NONE" : "BOUND_PI_STATE_UNVERIFIED"); }

    // ---- (4) ONE cancel of the positively bound TEST PI ---------------------------------------------------------------------------------
    r.writesSent += 1;
    try {
      const cx = await send({ op: "paymentIntents.cancel", id: piId, idempotencyKey: plan.cancelIdempotencyKey, params: {} });
      r.cancel.step = statusOf(cx) === "canceled" ? "CANCELED" : "UNEXPECTED_STATUS";
    } catch (e) {
      const code = tCode(e);
      if (!lastSent && DEFINITELY_NOT_SENT_T.includes(code)) { r.writesSent -= 1; r.cancel.step = "NOT_SENT"; }
      else r.cancel.step = code === "STRIPE_HTTP_4XX" ? "REFUSED" : "UNKNOWN";
    }

    // ---- (5) ONE final retrieve, whatever the cancel result (no second cancel, no retry) ------------------------------------------------
    try {
      const fin = await send(retrieveCall(piId));
      if (!boundPi(fin, piId, runRef, c) || statusOf(fin) === null) { r.final.step = "MISMATCH"; r.cleanup = "UNKNOWN"; return done("CLEANUP_UNKNOWN", "BOUND_PI_STATE_UNKNOWN"); }
      r.final.step = "OK"; r.final.status = statusOf(fin);
      r.final.amountReceived = nni(fin.amount_received) ? fin.amount_received : null; r.final.amountCapturable = nni(fin.amount_capturable) ? fin.amount_capturable : null;
      const lc = own(fin, "latest_charge");
      const chargeClean = lc === null || (isObj(lc) && lc.captured === false && lc.amount_captured === 0);
      if (r.final.status === "canceled" && fin.amount_received === 0 && fin.amount_capturable === 0 && chargeClean) r.cleanup = "VERIFIED";
      else if (r.final.status === "requires_capture") { r.cleanup = "NOT_DONE"; return done("CLEANUP_NOT_DONE", "AUTHORIZATION_HELD_UNTIL_EXPIRY"); }
      else if (r.final.status === "succeeded") { r.cleanup = "NOT_DONE"; return done("CAPTURED_UNEXPECTED", "TEST_CHARGE_CAPTURED_NEEDS_OPERATOR"); }
      else { r.cleanup = "NOT_VERIFIED"; return done("CLEANUP_NOT_VERIFIED", "BOUND_PI_STATE_UNVERIFIED"); }
    } catch {
      r.final.step = "UNKNOWN"; r.cleanup = "UNKNOWN";
      return done("CLEANUP_UNKNOWN", r.cancel.step === "CANCELED" ? "CANCEL_ACKED_READBACK_UNKNOWN" : "BOUND_PI_STATE_UNKNOWN");
    }
    // cleanup VERIFIED here
    if (r.retrieve.authorization !== "VERIFIED") return done("AUTH_TEST_AUTHORIZATION_NOT_VERIFIED");
    return done(r.retrieve.proofFields === "COMPLETE" ? "AUTH_TEST_COMPLETED_OK" : "AUTH_TEST_COMPLETED_PROOF_INCOMPLETE");
  } catch {
    r.exchanges = count;
    return done(r.writesSent > 0 ? "CLEANUP_UNKNOWN" : "CORE_INVALID", r.writesSent > 0 ? "BOUND_PI_STATE_UNKNOWN" : undefined);
  }
}

// =================================================================================================================================
// hosted wiring (gated; real fs / child / native https only inside runHosted with the real deps)
/** framed SHA-256 (same recipe as the accepted helper / hosted wrapper) over regular files, no symlink, bounded */
export async function framedDigest(dir, files, prefix = "e7-probe-source-v1\n") {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("AUTH_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("AUTH_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("AUTH_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
export const RUNNER_DIGEST_PREFIX = "e7-stripe-auth-runner-v1\n";
/** the children's env for the preflight fake-test child: job env minus every E7_* key, plus the (non-secret) tooling dir */
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
const TEST_FILE = "test/e7-stripe-authorization-test.test.mjs";

/**
 * runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws.
 *   deps (TEST SEAMS, real ones by default): spawnChild, importTooling(dir) → { T, X, C1 }, runCore, constants.
 */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const spawnChild = deps.spawnChild ?? spawnNode;
  const importTooling = deps.importTooling ?? defaultImportTooling;
  const runCore = deps.runCore ?? runAuthorizationCore;
  const r = { schema: "e7-stripe-auth-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, sourceDigest: null, runnerDigest: null,
    planKind: null, planHash: null, envCode: null, tests: null, core: null };
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("AUTH_USAGE");
    r.mode = mode;
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    const hasKey = typeof env.E7_STRIPE_TEST_KEY === "string" && env.E7_STRIPE_TEST_KEY.length > 0;
    if (mode !== "execute" && hasKey) refuse("AUTH_SECRET_SCOPE_VIOLATION");
    if (Object.keys(env).some((k) => /HOSTAWAY/i.test(k))) refuse("AUTH_SECRET_SCOPE_VIOLATION");            // no Hostaway secret / input in this job
    const runRef = env.E7_RUN_REF ?? ""; const ref = env.E7_APPROVAL_REF ?? "";
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expRun = env.E7_EXPECTED_RUNNER_DIGEST ?? "";
    if (runRef !== "" && !RUN_REF_RE.test(runRef)) refuse("AUTH_INPUT_INVALID");
    if (ref !== "" && !APPROVAL_RE.test(ref)) refuse("AUTH_INPUT_INVALID");
    if (runRef === c.synthetic.runRef || ref === c.synthetic.approvalRef) refuse("AUTH_INPUT_INVALID");      // synthetic never qualifies a real package
    let real;
    if (mode === "preflight") { if ((runRef === "") !== (ref === "")) refuse("AUTH_INPUT_INCOMPLETE"); real = runRef !== ""; }
    else {
      if (runRef === "" || ref === "" || !HEX64.test(expPlan) || !HEX64.test(expSrc) || !HEX64.test(expRun)) refuse("AUTH_INPUT_INCOMPLETE");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("AUTH_REF_NOT_MAIN");
      if (expSrc !== c.sourceDigest) refuse("AUTH_SOURCE_MISMATCH");
      real = true;
    }
    // ---- layout + (1) accepted 13-path closure BEFORE importing any tooling module ---------------------------------------------
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("AUTH_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("AUTH_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("AUTH_LAYOUT_INVALID");
    r.sourceDigest = await framedDigest(tooling, c.sourceClosure).catch((e) => refuse(e instanceof Refusal ? e.code : "AUTH_SOURCE_UNREADABLE"));
    if (r.sourceDigest !== c.sourceDigest) refuse("AUTH_SOURCE_MISMATCH");
    // ---- (2) this runner's own boundary (independent of the accepted closure) ----------------------------------------------------
    r.runnerDigest = await framedDigest(wdir, c.runnerFiles, RUNNER_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "AUTH_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.runnerDigest !== expRun) refuse("AUTH_RUNNER_MISMATCH");
    // ---- (3) plan ---------------------------------------------------------------------------------------------------------------------
    r.planKind = real ? "REAL" : "SYNTHETIC";
    const built = buildPlan(c, { runRef: real ? runRef : c.synthetic.runRef, approvalRef: real ? ref : c.synthetic.approvalRef, runnerDigest: r.runnerDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("AUTH_PLAN_HASH_MISMATCH");
    // ---- (4) accepted modules (digest verified above) + env evaluation -----------------------------------------------------------
    let mods; try { mods = await importTooling(tooling); } catch { refuse("AUTH_IMPORT_FAILED"); }
    const present = Object.fromEntries(mods.C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = mods.C1.evaluateProbeEnvironment({ schema: mods.C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && mods.C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("AUTH_ENV_REFUSED");
    // ---- (5) preflight: the FAKE test suite as a plain child (no secrets, no provider) ------------------------------------------------
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", TEST_FILE], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("AUTH_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), connectivityEvidence: false };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("AUTH_TESTS_FAILED");
      r.code = real ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    // ---- (6) execute: the ONLY step that sees the TEST key; read once, removed from process env ----------------------------------------
    if (!hasKey) refuse("AUTH_CREDENTIALS_MISSING");
    let key = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    const credential = () => key;
    const ex = mods.X.createE7RealExchange({ provider: "stripe" });
    if (!ex || ex.ok !== true) refuse("AUTH_IMPORT_FAILED");
    const ac = new AbortController();
    const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
    try { r.core = await runCore({ plan: built.plan, body: built.body, exchange: ex.exchange, credential, createStripeSend: mods.T.createE7StripeTestSend, runSignal: ac.signal }); }
    finally { key = null; proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    r.code = "EXECUTE_DONE";
    return { exitCode: r.core && r.core.outcome === "AUTH_TEST_COMPLETED_OK" ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "AUTH_INTERNAL";
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
  const k = r.core;
  const rows = [["mode", r.mode], ["code", r.code], ["workflow commit", r.workflowSha], ["tooling commit", r.toolingCommit], ["sourceDigest (computed)", r.sourceDigest],
    ["runnerDigest (computed)", r.runnerDigest], ["plan kind", r.planKind], ["planHash", r.planHash], ["env", r.envCode],
    ["fake tests (NOT connectivity)", r.tests ? `status ${r.tests.status}, pass ${r.tests.pass}/${r.tests.tests}, fail ${r.tests.fail}` : null],
    ["outcome", k ? k.outcome : null], ["exchanges / writes sent", k ? `${k.exchanges} / ${k.writesSent}` : null], ["PaymentIntent (bound)", k ? k.paymentIntentId : null],
    ["cleanup", k ? k.cleanup : null], ["residual", k ? k.residual : null]];
  return `### E7 Stripe TEST authorization rehearsal\n\n| field | value |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b === null || b === undefined ? "—" : String(b)} |`).join("\n")}\n\n\`\`\`json\n${JSON.stringify(r)}\n\`\`\`\n`;
}

if (import.meta.main === true) {
  const mode = process.argv[2] ?? "preflight";
  const wrapperDir = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
  const { exitCode, result } = await runHosted({ mode, env: process.env, proc: process, wrapperDir });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result)).catch(() => {});
  process.exitCode = exitCode;
}
