// scripts/e7-hosted-pipeline.mjs — E7 C90: HOSTED TEST PIPELINE runner. ONE bounded invocation of the ACCEPTED coordinator
// (lib/booking-db/test-pipeline-coordinator.js, C83 / C86 / C88, merged e7-test 07011a79; pinned tooling e7-test 71c3dcf8 = #128 + #129) for
// ONE explicitly bound fresh TEST checkout on listing 606998. It replaces the manual S1 / S2 / S4 dispatch sequence (reservation → capture →
// recording). The coordinator drives the three ACCEPTED workers (runOrchestratorStep / runCaptureStep / runRecordingStep) over the ACCEPTED
// executor adapters + HTTP transports; this file re-implements none of them and edits no existing runner.
//
// HONEST LABEL: OPENED (C92 ENABLE, separately reviewed) for ONE gated TEST run. CONSTANTS.executeEnabled is TRUE, so `verify` / `execute` proceed to
// the exact closure / source / plan / approval / main-ref bindings (closed constants still refuse HPL_EXECUTE_CLOSED right after the key-name / mode
// checks — BEFORE any input value, tooling import, credential, database or provider access; asserted through the closed-constants test seam). The
// exact reverse CLOSE patch is in the ENABLE PR body and restores executeEnabled false at END or STOP.
// MANUAL hosted TEST runner (workflow_dispatch + the EXISTING `e7-readonly-probe` reviewer gate). NOT automatic checkout, NOT a cron / webhook /
// API / UI path. ONE coordinator invocation per dispatch; no sleep, poll or re-dispatch loop; never self-retries.
//
// Binding (all in the plan hash): approval label, ONE intent id, its booking ref, expected version, notBefore, PaymentIntent, amount (minor), USD,
// listing 606998, tooling commit + closure digest, source digest. The run id (E7_RUN_ID) is the recording clientSnapshotId label (outside the hash).
//   * Historical exclusion: the reviewed C82 protected set (abede8b1… / c83c1842… / the C77 target 954d476c…) is refused by id; notBefore must be
//     ≥ HISTORICAL_FLOOR (after the C82 END read-only detail, 2026-11-15T18:25:03.568Z) and intent.createdAt ≥ notBefore, so EVERY intent that
//     existed at C82 (the 9-id END set) is refused by construction. Protected reservation ids refused everywhere. Listing fixed to 606998; the 28
//     migrated preview listings, 628381 / 628387 and the pilots 603564 / 603566 are refused explicitly too.
//   * Fresh read-only Stripe TEST proof (account + PI with latest_charge expanded, accepted v3 observation): BEFORE the coordinator (still-authorized
//     for payment_authorized / reservation_pending / reservation_confirmed; captured for payment_captured) AND, through the coordinator's
//     hooks.afterStep seam, AGAIN at each stage boundary inside the invocation: still-authorized before capture is admitted, captured (no refund)
//     before recording is admitted. Extra raw refusals beyond the v3 proof: charge.refunded must be false, not disputed, no multicapture.
//     The stored refund veto (coordinator F1) is ALSO checked before the lock; absence of stored refund evidence stays UNKNOWN, never proof.
//   * Late binding: capture / recording executors are bound only at their boundary, to the reservation id the ACCEPTED reservation worker
//     persisted (never adopted from a reply), via labelled copies of the reviewed candidate derivation; the Hostaway fence admits only that id.
//   * Target-only transport fence (counters before the transport): Stripe account / PI GETs, ≤ 1 capture POST (exact url / key / body);
//     Hostaway listing / calendar / priceDetails, lookups, GET of the bound id, ≤ 1 create POST (exact scope), the bound charge list, ≤ 1
//     offline-charge POST (exact title / amount / method / status). Nothing else, ever (no cancel / void / refund / notify / account write).
//   * Session advisory lock (5432, pid-stable proof) before the coordinator and proven again after every step (hook); runner-owned abort +
//     wall deadline handed to the coordinator (deadlineAt / signal).
//   * SECURITY DEPENDENCY (C91 contract, ROOT review 5912770410): the boundary re-proofs (still-authorized before capture, captured + echo before
//     recording), the late executor binding and the per-step lock proof run in the coordinator's hooks.afterStep. The pinned coordinator documents
//     that hook as "tests / operator logging only", but it AWAITS it after each step and a throw is a STOP before any next step / write (catch →
//     STEP_THREW_<code>, no further query). This wrapper RELIES on exactly that awaited throw→STOP behaviour; the real-coordinator test P11 asserts a
//     failed boundary hook blocks the next worker and its write. The accepted coordinator is NOT repinned or modified for the wording.
//   * C91-F1 supervision: every DB acquisition / statement and every runner provider await is locally bounded (connectMs / statementMs) and inside
//     ONE seal (deadline / abort / lock-session error / local timeout): sealing rejects every supervised await, destroys every tracked connection,
//     closes every fence / executor, discards late results and destroys late clients. A statement in flight at the seal after the coordinator was
//     admitted is an UNKNOWN DB outcome ⇒ STOP + possiblyEffected. The pinned pool / tooling are not modified.
//   * C91-F2: the no-dispute / no-refund raw proofs require the explicit boolean false; absent or malformed values refuse (unknown is not proof).
// Outcomes: CONFIRMED_VERIFIED only when the coordinator says CONFIRMED AND the durable readback verifies confirmed / exactly one succeeded
// create, capture and recording / captured amount / offline_charge_id linked / claim held / no cases / no forbidden op / notify undispatched.
// PENDING carries a sanitized nextActionAt and needs a FUTURE, separately dispatched attempt with fresh proof (exit 0, NOT completion).
// Anything else is STOP (exit 1): writes attempted are reported (possiblyEffected); never a repeat write, a repair, or reconcile-by-inference.
// Refunds stay MANUAL; no cancel / refund / void / cleanup / mirror / claim release / email automation here.
import process from "node:process";
import { readFile, realpath, lstat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const freeze = Object.freeze;
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

/** the 28 migrated preview listings (merged lib/public-catalog.js MIGRATED_PREVIEW_LISTING_IDS) + the never-public / pilot ids: refused by id */
const MIGRATED = [628346, 628372, 628373, 628374, 628375, 628376, 628377, 628378, 628379, 628380, 628382, 628383, 628384, 628385, 628386,
  628388, 628389, 628390, 628391, 628392, 628393, 628394, 628395, 628396, 628397, 628398, 628399, 628400];

export const CONSTANTS = deepFreeze({
  toolingCommit: "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5",        // e7-test: merge #129 (C87) on top of #128 (coordinator C83/C86/C88, merge 07011a79); immutable
  toolingStatus: "MERGED",
  executeEnabled: true,                                               // C92 ENABLE (ONE gated TEST run; reverse CLOSE patch restores false); closed constants refuse HPL_EXECUTE_CLOSED
  // the INDEPENDENTLY scanned transitive relative imports of the twelve tooling roots at 71c3dcf8 (+ package files); bare imports: node:* and pg only
  closure: ["lib/bookability.js", "lib/booking-db/capture-worker.js", "lib/booking-db/codec.js", "lib/booking-db/config.js", "lib/booking-db/operations.js",
    "lib/booking-db/pool.js", "lib/booking-db/recording-worker.js", "lib/booking-db/recovery.js", "lib/booking-db/repo.js", "lib/booking-db/reservation-worker.js",
    "lib/booking-db/test-pipeline-coordinator.js", "lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/final-price.js",
    "lib/checkout/intent-state.js", "lib/checkout/offline-charge-proof.js", "lib/checkout/recovery-plan.js", "lib/checkout/server-pricer.js", "lib/direct-policy.js",
    "lib/direct-pricing.js", "lib/hostaway-calendar.js", "lib/hostaway-reservations.js", "lib/hostaway.js", "lib/public-api.js", "lib/quote-public.js",
    "package-lock.json", "package.json", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs",
    "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/real-exchange.mjs", "scripts/e7-connected/run-lock-precheck.mjs"],
  closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273",   // framed SHA-256 of `closure` at 71c3dcf8 (the test recomputes it from the pinned tree + an independent import scan)
  pgVersion: "8.18.0",
  runnerFiles: ["scripts/e7-hosted-pipeline.mjs", "test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs", ".github/workflows/e7-hosted-pipeline.yml"],
  accountId: "acct_1TyHE42B9LTneQgw", stripeVersion: "2026-01-28.clover",
  listingId: 606998, currency: "USD", refFieldId: 105433, listingTimeZone: "America/Mexico_City",
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu", nodeVersion: "22.22.0",
  protectedReservationIds: ["70636076", "71045356", "71072615", "71081885"],
  // the reviewed C82 protected intent set: the two historical TEST intents + the C77 target (MV-XXU5YPDP, R71781276, confirmed). Never admitted.
  excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103"],
  historicalFloor: "2026-11-15T18:25:04.000Z",                        // > the C82 END read-only detail (18:25:03.568Z): every C82-era intent is older
  excludedListingIds: [...MIGRATED, 628381, 628387, 603564, 603566],
  paymentMethod: "credit_card", accountRef: "hostaway-e7-test",       // = the reviewed main recording runner's TEST recording configuration
  // ONE coordinator invocation; its own step / write budgets are authoritative (≤ 6 steps, ≤ 1 create / capture / record). Fence ceilings ≈ 3x
  // the coordinator happy path (8 Hostaway pricing / lookup reads, 2 Stripe proofs per boundary, 4 charge lists).
  budgets: { coordinatorInvocations: 1, maxSteps: 6, create: 1, capture: 1, record: 1, accountReads: 8, piReads: 10, pricingCalls: 36, hostawayReads: 36,
    lookupPages: 24, chargeLists: 12, exchanges: 160, dbQueries: 1500, runMs: 12 * 60 * 1000, teardownMs: 5000, pendingHorizonMs: 7 * 24 * 60 * 60 * 1000,
    // C91-F1 LOCAL bounds (the pinned pool sets a server statement_timeout but no connect / client deadline): every acquisition ≤ connectMs and every
    // statement ≤ statementMs, enforced HERE; a breach SEALS the run (no further DB / provider admission) and destroys the affected connections
    connectMs: 10000, statementMs: 30000 },
  synthetic: { approvalRef: "SYNTHETIC-pipeline-preflight-not-for-execute", intentId: "00000000-0000-4000-8000-000000000000", ref: "MV-SYNTH000",
    expectedVersion: 4, notBefore: "2026-11-16T00:00:00.000Z", paymentIntentId: "pi_SYNTHETIC00000000000000", amountMinor: 1, currency: "USD" }
});

class Refusal extends Error { constructor(code) { super("e7-hosted-pipeline"); this.code = code; } }
const refuse = (code) => { throw new Refusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/; const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RID_RE = /^[1-9][0-9]{0,15}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const CHARGE_RE = /^(ch|py)_[A-Za-z0-9_]{1,200}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const RUN_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CODE_RE = /^[A-Za-z0-9_:>!.-]{1,96}$/;
const STRIPE = "https://api.stripe.com"; const HOSTAWAY = "https://api.hostaway.com";
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);
const code = (v, fb) => (typeof v === "string" && CODE_RE.test(v) ? v : fb);

export const PLAN_SCHEMA = "e7-hosted-pipeline-plan-v1";
export const RESULT_SCHEMA = "e7-hosted-pipeline-result-v1";
export const OUTCOMES = freeze(["CONFIRMED_VERIFIED", "PENDING", "STOP"]);
export const HOSTED_CODES = freeze(["HPL_USAGE", "HPL_INPUT_UNEXPECTED", "HPL_EXECUTE_CLOSED", "HPL_SECRET_SCOPE_VIOLATION", "HPL_INPUT_INVALID", "HPL_INPUT_INCOMPLETE",
  "HPL_INTENT_EXCLUDED", "HPL_REF_NOT_MAIN", "HPL_LAYOUT_INVALID", "HPL_SOURCE_UNREADABLE", "HPL_SOURCE_MISMATCH", "HPL_CLOSURE_MISMATCH", "HPL_PLAN_HASH_MISMATCH",
  "HPL_IMPORT_FAILED", "HPL_ENV_REFUSED", "HPL_CHILD_FAILED", "HPL_TESTS_FAILED", "HPL_CREDENTIALS_MISSING", "HPL_DEPENDENCY_MISMATCH", "HPL_DB_TARGET_INVALID",
  "HPL_CA_INVALID", "HPL_INTERNAL"]);

// ---- LABELLED COPIES of scripts/e7-hosted-reservation.mjs pure helpers (asserted equal by the tests; no runner file is imported) ---------------
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
const MAX_FILE = 1048576; const MAX_TOTAL = 8388608;
export async function framedDigest(dir, files, prefix) {
  const h = createHash("sha256"); h.update(prefix); let total = 0;
  for (const rel of files) {
    const p = `${dir}/${rel}`; const st = await lstat(p);
    if (!st.isFile() || st.size < 1 || st.size > MAX_FILE) refuse("HPL_SOURCE_UNREADABLE");
    const b = await readFile(p); if (b.length !== st.size) refuse("HPL_SOURCE_UNREADABLE");
    total += b.length; if (total > MAX_TOTAL) refuse("HPL_SOURCE_UNREADABLE");
    h.update(rel); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0]));
  }
  return h.digest("hex");
}
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
export function dbTargetOk(url, c = CONSTANTS) {
  let u; try { u = new URL(url); } catch { return false; }
  return (u.protocol === "postgresql:" || u.protocol === "postgres:") && u.hostname === "aws-0-us-east-1.pooler.supabase.com" && u.port === "6543"
    && decodeURIComponent(u.username) === `mv_booking_app_dev.${c.dbProjectRef}` && u.pathname === "/postgres" && u.search === "" && u.hash === "";
}
export const SESSION_LOCK_PORT = "5432";
export function sessionLockUrl(url, c = CONSTANTS) {
  if (!dbTargetOk(url, c)) return null;
  const u = new URL(url); u.port = SESSION_LOCK_PORT;
  return u.href;
}
export const OFFICIAL_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7";
/** LABELLED COPY of the accepted offline-charge wire forms (scripts/e7-hosted-recording.mjs; cross-checked by the tests) */
export const offlineChargeTitle = (intentId) => `maraVilla payment mvoch1-${intentId}`;
export const exactAmount = (minor) => { if (!isAmount(minor)) return null; const n = Number(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`); return Number.isFinite(n) ? n : null; };

// ---- the plan ------------------------------------------------------------------------------------------------------------------------
export const PLAN_INPUT_KEYS = freeze(["approvalRef", "intentId", "ref", "expectedVersion", "notBefore", "paymentIntentId", "amountMinor", "currency"]);
export function buildPlan(c, { approvalRef, intentId, ref, expectedVersion, notBefore, paymentIntentId, amountMinor, currency, sourceDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef) || typeof intentId !== "string" || !ANY_UUID_RE.test(intentId)) refuse("HPL_INPUT_INVALID");
  if (typeof ref !== "string" || !/^MV-[A-Z0-9]{6,10}$/.test(ref) || !isVersion(expectedVersion) || isoMs(notBefore) === null) refuse("HPL_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId) || !isAmount(amountMinor) || currency !== c.currency) refuse("HPL_INPUT_INVALID");
  if (typeof sourceDigest !== "string" || !HEX64.test(sourceDigest)) refuse("HPL_INPUT_INVALID");
  if (c.listingId !== 606998 || c.currency !== "USD" || c.dbEnvironment !== "test" || c.budgets.create !== 1 || c.budgets.capture !== 1 || c.budgets.record !== 1
      || c.budgets.coordinatorInvocations !== 1 || c.budgets.maxSteps > 8 || c.excludedListingIds.includes(c.listingId)) refuse("HPL_INPUT_INVALID");       // code ceiling
  const plan = { schema: PLAN_SCHEMA, kind: "e7-test-pipeline-one-bound-intent", approvalRef, intentId, ref, expectedVersion, notBefore, paymentIntentId, amountMinor, currency,
    listingId: c.listingId, accountId: c.accountId, stripeVersion: c.stripeVersion, refFieldId: c.refFieldId, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef,
    toolingCommit: c.toolingCommit, closureDigest: c.closureDigest, sourceDigest, historicalFloor: c.historicalFloor, excludedIntentIds: c.excludedIntentIds,
    protectedReservationIds: c.protectedReservationIds, paymentMethod: c.paymentMethod, accountRef: c.accountRef,
    captureIdempotencyKey: `cap:${intentId}:${paymentIntentId}`, recordingIdempotencyKey: `och:${intentId}:1`, title: offlineChargeTitle(intentId), amount: exactAmount(amountMinor),
    budgets: { ...c.budgets }, writes: { create: 1, capture: 1, record: 1, refund: 0, cancel: 0, void: 0, notify: 0, account: 0 }, executeEnabled: c.executeEnabled };
  return { plan: deepFreeze(plan), planHash: sha(canonical(plan)) };
}

// =================================================================================================================================
// DB reads (read-only SELECTs as the runtime app role; no transaction held across a provider call)
export const QUERIES = deepFreeze({
  instance: "/*e7hpl:instance*/ SELECT environment FROM booking.instance",
  role: `/*e7hpl:role*/ SELECT pg_has_role(current_user, 'mv_booking_app', 'MEMBER') AS is_app, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS privileged`,
  identity: "/*e7hpl:identity*/ SELECT current_database() AS db, (SELECT environment FROM booking.instance) AS environment",
  row: "/*e7hpl:row*/ SELECT state, version, listing_id, hostaway_reservation_id::text AS rid, offline_charge_id::text AS och FROM booking.intents WHERE id = $1",
  attempts: "/*e7hpl:attempts*/ SELECT id::text AS id, status, payment_intent_id, livemode FROM booking.payment_attempts WHERE intent_id = $1 ORDER BY attempt",
  hostaway: "/*e7hpl:hostaway*/ SELECT state, hostaway_reservation_id::text AS rid FROM booking.hostaway_reservation_attempts WHERE intent_id = $1",
  ops: `/*e7hpl:ops*/ SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS dispatched, result_ref, late_result_ref, idempotency_key,
      payload ->> 'reservationId' AS payload_rid, payload ->> 'paymentIntentId' AS payload_pi, (payload ->> 'amountMinor')::bigint AS payload_amount,
      payload ->> 'providerIdempotencyKey' AS payload_key
      FROM booking.external_operations WHERE intent_id = $1 ORDER BY created_at, id`,
  cases: "/*e7hpl:cases*/ SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'",
  claims: "/*e7hpl:claims*/ SELECT listing_id, (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1",
  evidence: "/*e7hpl:evidence*/ SELECT kind, external_ref, observed FROM booking.provider_evidence WHERE intent_id = $1 AND kind = 'payment_intent' AND external_ref = $2",
  guest: `/*e7hpl:guest*/ SELECT g.first_name, g.last_name, g.email FROM (SELECT 1) one LEFT JOIN booking.intent_guests g ON g.intent_id = $1`
});
const Q = QUERIES;
const CREATE = "hostaway.create_reservation"; const CAPTURE = "stripe.capture_payment_intent"; const RECORD = "hostaway.record_offline_charge";
const NOTIFY = "guest.notify";
const FORBIDDEN_OPS = freeze(["stripe.void_payment_intent", "hostaway.cancel_reservation", "alert.owner", "stripe.refund_payment_intent", "stripe.retrieve_refund",
  "hostaway.refund_offline_charge"]);
const PIPELINE_STATES = freeze(["payment_authorized", "reservation_pending", "reservation_confirmed", "payment_captured"]);
const UNSETTLED_OP_STATES = freeze(["in_flight", "outcome_unknown", "escalated"]);
const pristine = (o) => o && o.state === "pending" && Number(o.attempts) === 0 && o.dispatched === false;

export async function readFacts(q, plan, tooling, raw) {
  const inst = await q(Q.instance, []);
  const row = await q(Q.row, [plan.intentId]);
  let intent = null;
  if (row.length === 1) intent = await tooling.loadIntent(raw, plan.intentId);                         // accepted repo read over the counted pool
  const attempts = await q(Q.attempts, [plan.intentId]);
  const hostaway = await q(Q.hostaway, [plan.intentId]);
  const ops = await q(Q.ops, [plan.intentId]);
  const cases = await q(Q.cases, [plan.intentId]);
  const claims = await q(Q.claims, [plan.intentId]);
  const evidence = await q(Q.evidence, [plan.intentId, plan.paymentIntentId]);
  return freeze({ instance: inst[0]?.environment ?? null, row: row[0] ?? null, intent, attempts, hostaway, ops, openCases: cases[0]?.n ?? null, claims, evidence });
}

/** the facts every admission / readback shares (scope, historical exclusion, protection, binding to the PINNED ref / PI / amount) → null | code */
export function checkCommon(f, plan, c = CONSTANTS) {
  if (f.instance !== c.dbEnvironment) return "DATABASE_NOT_TEST";
  if (c.excludedIntentIds.includes(plan.intentId)) return "INTENT_EXCLUDED";
  const i = f.intent;
  if (!i || !f.row) return "INTENT_NOT_FOUND";
  if (i.id !== plan.intentId) return "INTENT_NOT_PINNED";
  if (i.listingId !== c.listingId || c.excludedListingIds.includes(i.listingId) || Number(f.row.listing_id) !== c.listingId) return "LISTING_NOT_SCOPED";
  if (i.ref !== plan.ref || !REF_RE.test(String(i.ref))) return "REF_NOT_PINNED";
  const nb = isoMs(plan.notBefore);
  if (nb === null || nb < isoMs(c.historicalFloor) || !Number.isSafeInteger(i.createdAt) || i.createdAt < nb) return "HISTORIC_INTENT";
  if (!i.price || i.price.currency !== c.currency || i.price.finalTotalMinor !== plan.amountMinor) return "AMOUNT_NOT_PINNED";
  if (!i.payment || i.payment.livemode !== false) return "PAYMENT_NOT_TEST";
  if (i.payment.paymentIntentId !== plan.paymentIntentId) return "PAYMENT_INTENT_NOT_PINNED";
  if (i.payment.amountMinor !== plan.amountMinor || String(i.payment.currency || "").toUpperCase() !== c.currency) return "AUTHORIZED_AMOUNT_NOT_PRICE";
  const protectedRef = (v) => v !== null && v !== undefined && c.protectedReservationIds.includes(String(v));
  if (i.reservation && protectedRef(i.reservation.reservationId)) return "PROTECTED_REFERENCE";
  if (protectedRef(f.row.rid)) return "PROTECTED_REFERENCE";
  for (const h of f.hostaway) if (protectedRef(h.rid)) return "PROTECTED_REFERENCE";
  for (const o of f.ops) if (protectedRef(o.result_ref) || protectedRef(o.late_result_ref) || protectedRef(o.payload_rid)) return "PROTECTED_REFERENCE";
  for (const o of f.ops) if (FORBIDDEN_OPS.includes(o.op_type)) return "FORBIDDEN_OP_PRESENT";
  for (const o of f.ops) if (o.op_type === NOTIFY && o.dispatched !== false) return "NOTIFY_DISPATCHED";
  const att = f.attempts.filter((a) => a.status === "completed");
  if (att.length !== 1 || att[0].livemode !== false || att[0].payment_intent_id !== plan.paymentIntentId) return "PAYMENT_ATTEMPT_NOT_SINGLE_COMPLETED";
  if (f.claims.length !== 1 || Number(f.claims[0].listing_id) !== c.listingId || f.claims[0].released !== false) return "CLAIM_NOT_HELD";
  if (f.openCases !== 0) return "OPEN_CASE";
  return null;
}

/**
 * candidateOf(f, c) → { ok:true, id:string|null } | { ok:false, code } — LABELLED COPY of scripts/e7-hosted-reservation.mjs candidateOf (the
 * conservative per-step binding id, without its admission pin): the adopted id, else the ONE succeeded create's result_ref; every other known id must
 * agree; a known id without a candidate, a conflict or a protected id STOPS.
 */
export function candidateOf(f, c = CONSTANTS) {
  const no = (k) => freeze({ ok: false, code: k });
  const i = f.intent; const known = new Set(); const cands = new Set();
  const seen = (v) => { if (v !== null && v !== undefined && c.protectedReservationIds.includes(String(v))) throw new Refusal("PROTECTED_REFERENCE"); return v === null || v === undefined ? null : String(v); };
  try {
    const adopted = i && i.reservation ? seen(i.reservation.reservationId) : null;
    if (adopted) { cands.add(adopted); known.add(adopted); }
    const creates = f.ops.filter((o) => o.op_type === CREATE);
    if (creates.length > 1) return no("FACTS_INCONSISTENT");
    for (const o of f.ops) { seen(o.result_ref); seen(o.late_result_ref); seen(o.payload_rid); }
    for (const o of creates) { const rr = seen(o.result_ref); const lr = seen(o.late_result_ref); if (rr) { known.add(rr); if (o.state === "succeeded") cands.add(rr); } if (lr) known.add(lr); }
    for (const h of f.hostaway) { const hid = seen(h.rid); if (hid) known.add(hid); }
    for (const o of f.ops) if (o.op_type === "hostaway.retrieve_reservation") { const sid = seen(o.payload_rid); if (!sid) return no("FACTS_INCONSISTENT"); known.add(sid); }
  } catch (e) { return no(e instanceof Refusal ? e.code : "FACT_MALFORMED"); }
  if (cands.size > 1) return no("CANDIDATE_CONFLICT");
  const id = cands.size === 1 ? [...cands][0] : null;
  if (id === null && known.size > 0) return no("KNOWN_ID_WITHOUT_CANDIDATE");
  for (const k of known) if (k !== id) return no("RESERVATION_ID_CONFLICT");
  if (id !== null && !RID_RE.test(id)) return no("RESERVATION_ID_INVALID");
  return freeze({ ok: true, id });
}

/** checkStart(f, plan, c) → { ok, intent, attemptId, candidate } | { ok:false, code } — read-only admission; the workers' in-tx guards stay authoritative */
export function checkStart(f, plan, c = CONSTANTS, tooling = null) {
  const no = (k) => freeze({ ok: false, code: k });
  const common = checkCommon(f, plan, c);
  if (common) return no(common);
  const i = f.intent;
  if (!PIPELINE_STATES.includes(i.status) || f.row.state !== i.status) return no("STATE_NOT_IN_PIPELINE");
  if (i.version !== plan.expectedVersion || Number(f.row.version) !== plan.expectedVersion) return no("VERSION_NOT_PINNED");
  if (f.row.och !== null || f.ops.some((o) => o.op_type === RECORD && !pristine(o))) return no("RECORDING_NOT_PRISTINE");
  for (const o of f.ops) if (UNSETTLED_OP_STATES.includes(o.state)) return no("OP_UNSETTLED");
  const caps = f.ops.filter((o) => o.op_type === CAPTURE);
  if (i.status === "payment_captured") {
    if (i.payment.capturedMinor !== plan.amountMinor) return no("CAPTURED_AMOUNT");
    if (caps.length !== 1 || caps[0].state !== "succeeded" || caps[0].dispatched !== true || !CHARGE_RE.test(String(caps[0].result_ref ?? ""))) return no("CAPTURE_NOT_SINGLE_SUCCEEDED");
  } else {
    if (i.payment.capturedMinor !== 0) return no("ALREADY_CAPTURED");
    if (caps.some((o) => !pristine(o))) return no("CAPTURE_NOT_PRISTINE");
  }
  for (const o of caps) if (o.payload_pi !== plan.paymentIntentId || Number(o.payload_amount) !== plan.amountMinor || o.payload_key !== plan.captureIdempotencyKey) return no("CAPTURE_ROW_NOT_BOUND");
  if (tooling && typeof tooling.captureKey === "function" && tooling.captureKey(plan.intentId, plan.paymentIntentId, 1) !== plan.captureIdempotencyKey) return no("CAPTURE_KEY_NOT_ACCEPTED");
  const recs = f.ops.filter((o) => o.op_type === RECORD);
  for (const o of recs) if (o.idempotency_key !== plan.recordingIdempotencyKey) return no("RECORDING_ROW_NOT_BOUND");
  const cand = candidateOf(f, c);
  if (!cand.ok) return no(cand.code);
  if ((i.status === "reservation_confirmed" || i.status === "payment_captured") && (cand.id === null || !i.reservation || String(i.reservation.reservationId) !== cand.id)) return no("RESERVATION_NOT_BOUND");
  return freeze({ ok: true, intent: i, attemptId: f.attempts.find((a) => a.status === "completed").id, candidate: cand.id });
}

/** checkEnd(f, plan, c) → null | code — the DURABLE facts a CONFIRMED_VERIFIED outcome must show (anything else = POSTCHECK_MISMATCH) */
export function checkEnd(f, plan, c = CONSTANTS) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  const i = f.intent;
  if (i.status !== "confirmed" || f.row.state !== "confirmed") return "STATE_NOT_CONFIRMED";
  if (i.payment.capturedMinor !== plan.amountMinor) return "CAPTURED_AMOUNT";
  const one = (t) => f.ops.filter((o) => o.op_type === t);
  const cr = one(CREATE); const cp = one(CAPTURE); const rc = one(RECORD);
  if (cr.length !== 1 || cr[0].state !== "succeeded" || cr[0].dispatched !== true || !RID_RE.test(String(cr[0].result_ref ?? ""))) return "CREATE_NOT_SINGLE_SUCCEEDED";
  const rid = String(cr[0].result_ref);
  if (!i.reservation || String(i.reservation.reservationId) !== rid || String(f.row.rid ?? "") !== rid) return "RESERVATION_NOT_LINKED";
  if (cp.length !== 1 || cp[0].state !== "succeeded" || cp[0].dispatched !== true || Number(cp[0].attempts) !== 1 || !CHARGE_RE.test(String(cp[0].result_ref ?? ""))) return "CAPTURE_NOT_SINGLE_SUCCEEDED";
  if (cp[0].payload_pi !== plan.paymentIntentId || Number(cp[0].payload_amount) !== plan.amountMinor || cp[0].payload_key !== plan.captureIdempotencyKey) return "CAPTURE_ROW_NOT_BOUND";
  if (rc.length !== 1 || rc[0].state !== "succeeded" || rc[0].dispatched !== true || Number(rc[0].attempts) !== 1 || rc[0].idempotency_key !== plan.recordingIdempotencyKey
      || !/^[1-9][0-9]{0,15}$/.test(String(rc[0].result_ref ?? ""))) return "RECORDING_NOT_SINGLE_SUCCEEDED";
  if (String(f.row.och ?? "") !== String(rc[0].result_ref)) return "OFFLINE_CHARGE_NOT_LINKED";
  for (const o of f.ops) if (UNSETTLED_OP_STATES.includes(o.state)) return "OP_UNSETTLED";
  return null;
}
/** checkPending(f, plan, c) → null | code — a PENDING result is only reported over settled, case-free, in-pipeline durable facts */
export function checkPending(f, plan, c = CONSTANTS) {
  const common = checkCommon(f, plan, c);
  if (common) return common;
  if (!PIPELINE_STATES.includes(f.intent.status)) return "STATE_NOT_IN_PIPELINE";
  for (const o of f.ops) if (UNSETTLED_OP_STATES.includes(o.state)) return "OP_UNSETTLED";
  for (const t of [CREATE, CAPTURE, RECORD]) if (f.ops.filter((o) => o.op_type === t).length > 1) return "WRITE_ROW_NOT_SINGLE";
  return null;
}

// =================================================================================================================================
// fresh Stripe proofs (pure over the accepted v3 observation + raw fields the observation does not copy)
/** raw refusals the v3 observation does not cover: refund flag, dispute, multicapture (capture ambiguity). Fail-closed: refunded and disputed must be the
 *  explicit boolean false (absent / null / string / number / object refuse); listed refunds, multicapture availability / request refuse. */
export function piRawRefusal(pi) {
  if (!isObj(pi)) return "PI_NOT_OBJECT";
  const ch = pi.latest_charge;
  if (!isObj(ch)) return "CHARGE_NOT_EXPANDED";
  if (ch.refunded !== false) return "CHARGE_REFUNDED_FLAG";
  if (ch.disputed === true) return "CHARGE_DISPUTED";
  if (ch.disputed !== false) return "CHARGE_DISPUTE_UNKNOWN";                                       // C91-F2: explicit typed false only; absent / malformed = unknown = refused
  if (isObj(ch.refunds) && Array.isArray(ch.refunds.data) && ch.refunds.data.length !== 0) return "CHARGE_REFUND_LISTED";
  const card = isObj(ch.payment_method_details) && isObj(ch.payment_method_details.card) ? ch.payment_method_details.card : null;
  if (card && card.multicapture !== undefined && card.multicapture !== null && !(isObj(card.multicapture) && card.multicapture.status === "unavailable")) return "MULTICAPTURE_AVAILABLE";
  const opt = isObj(pi.payment_method_options) && isObj(pi.payment_method_options.card) ? pi.payment_method_options.card.request_multicapture : undefined;
  if (opt !== undefined && opt !== null && opt !== "never") return "MULTICAPTURE_REQUESTED";
  return null;
}
/** proofRefusal(kind, pi, intent, attemptId, tooling, observedAt) → null | code. kind "authorized" (before capture) | "captured" (before recording) */
export function proofRefusal(kind, pi, intent, attemptId, tooling, observedAt) {
  const raw = piRawRefusal(pi);
  if (raw) return raw;
  const observed = tooling.paymentIntentProofObservationV3(pi, { accountVerified: true });
  const PI = intent.payment.paymentIntentId;
  const ev = { id: "runner-readback", kind: "payment_intent", readOpType: "stripe.retrieve_payment_intent", requestRef: PI, externalRef: PI, status: observed.status, observed, observedAt };
  if (kind === "authorized") { const k = tooling.stillAuthorizedV3Refusal(ev, intent, attemptId); return k ? code(String(k), "PI_PROOF") : null; }
  if (kind !== "captured") return "PROOF_KIND";
  if (!tooling.piCapturedProof(ev, intent, attemptId)) return "PI_NOT_CAPTURED_PROOF";
  if (observed.amountCapturableMinor !== 0 || observed.latestCharge.amountRefundedMinor !== 0 || observed.latestCharge.paid !== true) return "PI_CAPTURED_SHAPE";
  return null;
}
/** sanitizeNextActionAt(ms, nowMs, horizonMs) → ISO string | null (finite, safe, not absurdly past, within the horizon) */
export function sanitizeNextActionAt(ms, nowMs, horizonMs = CONSTANTS.budgets.pendingHorizonMs) {
  if (!Number.isSafeInteger(ms) || !Number.isFinite(nowMs) || ms <= 0) return null;
  if (ms < nowMs - 24 * 60 * 60 * 1000 || ms > nowMs + horizonMs) return null;
  return new Date(ms).toISOString();
}

// =================================================================================================================================
/**
 * runPipelineCore({ plan, pool, lockClientFactory?, tooling, exchanges: { stripe, hostaway }, credentials: { stripe, hostaway }, runId, clock?, recordingClock?,
 *                   now?, runSignal?, timer? }) → frozen result. ONE coordinator invocation at most.
 * tooling = { runTestPipelineCoordinator, refundObservationRefusal, loadIntent, createPhaseExecutors, createStripeSend, createHostawaySend, validateAdapterConfig,
 *             unwrapEnvelope, normalizeReservation, paymentIntentProofObservationV3, stillAuthorizedV3Refusal, piCapturedProof, captureKey, LOCK_KEY, LOCK_PRECHECK_SQL }
 */
export const TOOLING_KEYS = freeze(["runTestPipelineCoordinator", "refundObservationRefusal", "loadIntent", "createPhaseExecutors", "createStripeSend", "createHostawaySend",
  "validateAdapterConfig", "unwrapEnvelope", "normalizeReservation", "paymentIntentProofObservationV3", "stillAuthorizedV3Refusal", "piCapturedProof", "captureKey"]);
export async function runPipelineCore(input) {
  const c = CONSTANTS; const B = c.budgets;
  const r = { schema: RESULT_SCHEMA, outcome: null, code: null, startState: null, finalState: null, finalVersion: null, reservationId: null, chargeId: null, offlineChargeId: null,
    nextActionAt: null, coordinator: null, coordinatorInvocations: 0, proofs: [], possiblyEffected: false, verifiedCompletion: false,
    sends: { create: 0, capture: 0, record: 0 }, replies: { create: "NONE", capture: "NONE", record: "NONE" }, exchanges: 0, accountReads: 0, piReads: 0, pricingCalls: 0,
    hostawayReads: 0, lookupPages: 0, chargeLists: 0, refusedAtTransport: 0, refusedByStop: 0, dbQueries: 0, dbBudgetRefused: 0, lock: "not_acquired", lockSession: null,
    stopReason: null, factsObserved: false, postcheck: null };
  const DONE = Symbol("done");
  const done = (outcome, k = null) => { if (!finalized) { r.outcome = outcome; r.code = k === null ? null : code(String(k), "CODE"); } return DONE; };
  const stop = (k) => done("STOP", k);
  r.sealed = false; r.sealReason = null; r.dbInFlightAtSeal = 0; r.dbOutcomeUnknown = false; r.lateClientsDestroyed = 0; r.clientsDestroyed = 0; r.coordinatorSettled = null;
  let stopReason = null; let lockT = null; let lockAcquired = false; let lockErrored = false; let lockPid = null; let timerHandle = null; let finalized = false;
  const stopAc = new AbortController();
  // ---- C91-F1 SUPERVISION. ONE seal (wall deadline / run abort / lock-session error / a LOCAL connect or statement timeout) ends ALL DB and provider
  // admission at once: every supervised await rejects, every tracked connection (worker / coordinator / runner / lock) is DESTROYED, every fence and
  // executor refuses, and a late-arriving client or result is discarded (a late client is destroyed before any use). Statements in flight at the seal
  // after the coordinator was admitted are an UNKNOWN DB outcome (possiblyEffected); runner reads before it are read-only. Never a bare race: the body,
  // the coordinator and every DB / provider await are inside the seal, so nothing can continue to a coordinator / provider stage after expiration.
  const B0 = CONSTANTS.budgets;
  const setT = input && typeof input.timer === "function" ? input.timer : (fn, ms) => setTimeout(fn, ms);
  const clearT = input && typeof input.clearTimer === "function" ? input.clearTimer : (h) => clearTimeout(h);
  const sealHooks = new Set(); const tracked = new Set(); let inFlight = 0; let coordinatorAdmitted = false; let coP = null;
  class Stopped extends Error { constructor() { super("stopped"); this.code = "RUNNER_STOPPED"; } }
  class DbTimeout extends Error { constructor(k) { super("db timeout"); this.code = k; } }
  const finish = (t, destroyIt) => { if (!t || t.released) return; t.released = true; tracked.delete(t); if (destroyIt) r.clientsDestroyed += 1; try { t.cl.release(destroyIt ? true : undefined); } catch { /* contained */ } };
  const destroy = (t) => { if (!t || t.released) return; t.released = true; tracked.delete(t); r.clientsDestroyed += 1; try { t.cl.release(true); } catch { /* contained */ } };
  const seal = (why) => {
    if (r.sealed) return;
    r.sealed = true; r.sealReason = code(String(why), "SEALED");
    if (stopReason === null) { stopReason = r.sealReason; r.stopReason = stopReason; }
    r.dbInFlightAtSeal = inFlight;
    if (coordinatorAdmitted && inFlight > 0) r.dbOutcomeUnknown = true;
    try { stopAc.abort(); } catch { /* ignore */ }
    for (const fn of [...sealHooks]) { try { fn(); } catch { /* ignore */ } }
    sealHooks.clear();
    for (const t of [...tracked]) destroy(t);
  };
  /** supervise(p, ms?, onTimeout?) — the ONLY way this core awaits DB / provider / coordinator work: rejects Stopped on the seal (or if sealed before /
   *  at resolution), rejects DbTimeout after `ms` (onTimeout runs first: destroy + seal); a late value is DISCARDED, never returned to a stage. */
  const supervise = (p, ms = null, onTimeout = null, k = "DB_TIMEOUT") => new Promise((resolve, reject) => {
    const pp = Promise.resolve(p);
    if (r.sealed) { pp.catch(() => {}); reject(new Stopped()); return; }
    let settled = false; let th = null;
    const fin = (fn) => { if (settled) return; settled = true; sealHooks.delete(onSeal); if (th !== null) { try { clearT(th); } catch { /* ignore */ } } fn(); };
    const onSeal = () => fin(() => reject(new Stopped()));
    sealHooks.add(onSeal);
    if (ms !== null) th = setT(() => fin(() => { try { if (onTimeout) onTimeout(); } catch { /* ignore */ } reject(new DbTimeout(k)); }), ms, "db");
    pp.then((v) => fin(() => (r.sealed ? reject(new Stopped()) : resolve(v))), (e) => fin(() => reject(r.sealed ? new Stopped() : e)));
  });
  const stopped = () => {
    if (!r.sealed) {
      if (input && input.runSignal && input.runSignal.aborted) seal("ABORTED");
      else if (lockErrored) seal("LOCK_SESSION_ERROR");
      else if (stopAc.signal.aborted) seal("DEADLINE");
    }
    return r.sealed ? stopReason : null;
  };
  class HookStop extends Error { constructor(k) { super("hook"); this.code = code(String(k), "HOOK_STOP"); } }
  const guard = () => { if (stopped()) throw new Stopped(); };
  const observe = (f) => {
    if (!f || !f.intent) return;
    r.factsObserved = true; r.finalState = f.intent.status; r.finalVersion = f.intent.version;
    r.reservationId = f.intent.reservation && f.intent.reservation.reservationId != null ? String(f.intent.reservation.reservationId) : null;
    const caps = f.ops.filter((o) => o.op_type === CAPTURE);
    r.chargeId = caps.length === 1 && caps[0].state === "succeeded" && CHARGE_RE.test(String(caps[0].result_ref ?? "")) ? String(caps[0].result_ref) : null;
    r.offlineChargeId = f.row && f.row.och !== null && f.row.och !== undefined ? String(f.row.och) : null;
  };
  const body = async () => {
    const { plan, pool, tooling, exchanges, credentials, runId } = input ?? {};
    if (!plan || plan.schema !== PLAN_SCHEMA || plan.listingId !== c.listingId || plan.accountId !== c.accountId || plan.stripeVersion !== c.stripeVersion || plan.currency !== c.currency
        || !ANY_UUID_RE.test(String(plan.intentId)) || !REF_RE.test(String(plan.ref)) || !isVersion(plan.expectedVersion) || isoMs(plan.notBefore) === null
        || !PI_RE.test(String(plan.paymentIntentId)) || !isAmount(plan.amountMinor) || plan.captureIdempotencyKey !== `cap:${plan.intentId}:${plan.paymentIntentId}`
        || plan.recordingIdempotencyKey !== `och:${plan.intentId}:1` || plan.intentId === c.synthetic.intentId || c.excludedIntentIds.includes(plan.intentId)
        || typeof runId !== "string" || !RUN_ID_RE.test(runId)
        || !pool || typeof pool.query !== "function" || !tooling || !exchanges || typeof exchanges.stripe !== "function" || typeof exchanges.hostaway !== "function"
        || !credentials || typeof credentials.stripe !== "function" || typeof credentials.hostaway !== "function") return stop("CORE_INVALID");
    for (const k of TOOLING_KEYS) if (typeof tooling[k] !== "function") return stop("CORE_INVALID:TOOLING");
    if (typeof tooling.LOCK_KEY !== "string" || typeof tooling.LOCK_PRECHECK_SQL !== "string") return stop("CORE_INVALID:TOOLING");
    const clock = input.clock ?? (() => Date.now());
    const recordingClock = input.recordingClock ?? clock;
    const now = input.now ?? (() => Date.now());
    const deadlineAt = now() + B.runMs - B.teardownMs;
    timerHandle = setT(() => seal("DEADLINE"), B.runMs - B.teardownMs, "deadline");                 // C91-F1: the deadline SEALS (not only aborts a signal)
    if (input.runSignal && typeof input.runSignal.addEventListener === "function") input.runSignal.addEventListener("abort", () => seal("ABORTED"), { once: true });
    if (input.runSignal && input.runSignal.aborted) seal("ABORTED");
    const lockClientFactory = input.lockClientFactory ?? (() => pool.connect());
    const PI = plan.paymentIntentId; const IID = plan.intentId;

    // ---- (1) counted pool: EVERY statement (runner + coordinator + workers, connected clients included) is counted once at this boundary ------
    const count = () => { if (r.dbQueries >= B.dbQueries) { r.dbBudgetRefused += 1; throw new Refusal("DB_BUDGET"); } r.dbQueries += 1; };
    /** C91-F1 bounded acquisition: ≤ connectMs; a client that arrives after a timeout / the seal is destroyed before any use */
    const acquire = async (factory, sealCode) => {
      if (r.sealed) throw new Stopped();
      let lost = false; let got = null; let t = null;
      const kill = (cl) => { r.lateClientsDestroyed += 1; try { cl.release(true); } catch { /* contained */ } };
      const pc = Promise.resolve().then(() => factory());
      pc.then((cl) => { got = cl; if (lost && cl) kill(cl); }, () => {});
      try {
        const cl = await supervise(pc, B.connectMs, () => seal(sealCode), "DB_CONNECT_TIMEOUT");
        if (!cl || typeof cl.query !== "function" || typeof cl.release !== "function") { lost = true; if (cl) kill(cl); throw new Refusal("DB_CLIENT_INVALID"); }
        t = { cl, released: false }; tracked.add(t);
        if (r.sealed) { destroy(t); throw new Stopped(); }
        return t;
      } catch (e) { if (!t) { lost = true; if (got) { const g = got; got = null; kill(g); } } throw e; }
    };
    /** C91-F1 bounded statement: ≤ statementMs; a timeout destroys that connection and SEALS; in-flight statements are counted for the seal */
    const tq = (t, args, sealCode = "DB_STATEMENT_TIMEOUT") => {
      if (r.sealed || t.released) return Promise.reject(new Stopped());
      count(); inFlight += 1;
      let qp; try { qp = Promise.resolve(t.cl.query(...args)); } catch (e) { inFlight -= 1; return Promise.reject(e); }
      return supervise(qp, B.statementMs, () => { destroy(t); seal(sealCode); }, "DB_STATEMENT_TIMEOUT").finally(() => { inFlight -= 1; });
    };
    // the counted + SUPERVISED pool handed to the runner reads AND to the coordinator / workers (every statement goes through a tracked client)
    const countedPool = {
      query: async (...a) => { const t = await acquire(() => pool.connect(), "DB_CONNECT_TIMEOUT"); let ok = false;
        try { const res = await tq(t, a); ok = true; return res; } finally { finish(t, !ok); } },
      connect: async () => { const t = await acquire(() => pool.connect(), "DB_CONNECT_TIMEOUT");
        return { query: (...a) => tq(t, a), release: (arg) => finish(t, arg === true || arg instanceof Error),
          on: (...a) => (typeof t.cl.on === "function" ? t.cl.on(...a) : undefined),
          removeListener: (...a) => (typeof t.cl.removeListener === "function" ? t.cl.removeListener(...a) : undefined) }; }
    };
    const q = async (sql, params) => { guard(); const res = await countedPool.query(sql, params); return res.rows; };
    const raw = { query: (sql, params) => { guard(); return countedPool.query(sql, params); } };
    const read = () => readFacts(q, plan, tooling, raw);

    // ---- (2) read-only admission (pins re-read and cross-checked) + the stored refund veto (UNKNOWN when absent) ---------------------------------
    let f;
    try { f = await read(); } catch (e) { return e instanceof Stopped || e instanceof DbTimeout ? stop(`STOP_${stopReason ?? e.code}`) : stop("DB_ERROR:START_READ_FAILED"); }
    r.startState = f.intent ? f.intent.status : null; observe(f);
    const st = checkStart(f, plan, c, tooling);
    if (!st.ok) return stop(`ADMISSION_REFUSED:${st.code}`);
    const veto0 = tooling.refundObservationRefusal(f.evidence, PI);
    if (veto0) return stop(`ADMISSION_REFUSED:${veto0}`);
    const intent0 = st.intent; const attemptId = st.attemptId;
    const rate = intent0.price && Number.isSafeInteger(intent0.price.rateBps) ? intent0.price.rateBps : null;
    if (rate === null) return stop("ADMISSION_REFUSED:PRICE_RATE_MISSING");

    // ---- (3) LABELLED COPY (Slice 1 §3, F4): the session lock on a DEDICATED client; pid-stable proof ----------------------------------------------
    try { lockT = await acquire(lockClientFactory, "LOCK_CONNECT_TIMEOUT"); }
    catch (e) { return e instanceof Stopped ? stop(`STOP_${stopReason}`) : stop(e instanceof DbTimeout ? "STOP_LOCK_CONNECT_TIMEOUT" : "DB_ERROR:LOCK_CONNECT_FAILED"); }
    if (typeof lockT.cl.on === "function") lockT.cl.on("error", () => { lockErrored = true; r.lockSession = "error_observed"; seal("LOCK_SESSION_ERROR"); });
    const lockQuery = async (sql, params) => { guard(); return tq(lockT, [sql, params], "LOCK_STATEMENT_TIMEOUT"); };
    const PROOF_SQL = `SELECT (${tooling.LOCK_PRECHECK_SQL} AND l.pid = pg_catalog.pg_backend_pid()) AS n, pg_catalog.pg_backend_pid() AS pid`;
    const ownLock = async () => {
      if (lockErrored) return false;
      const x = await lockQuery(PROOF_SQL, [tooling.LOCK_KEY]);
      if (lockErrored || x.rows.length !== 1 || x.rows[0].n !== 1) return false;
      if (lockPid !== null && String(x.rows[0].pid) !== lockPid) { r.lockSession = "backend_hop"; return false; }
      return true;
    };
    try {
      const got = await lockQuery("SELECT pg_try_advisory_lock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [tooling.LOCK_KEY]);
      if (!(got.rows.length === 1 && got.rows[0].ok === true)) return stop("LOCK_NOT_ACQUIRED:RUN_LOCK_PRESENT");
      lockAcquired = true; lockPid = String(got.rows[0].pid);
      if (!(await ownLock())) return stop(r.lockSession === "backend_hop" ? "LOCK_NOT_ACQUIRED:BACKEND_HOP" : "LOCK_NOT_ACQUIRED:LOCK_NOT_PROVEN");
      r.lock = "held";
      const a = await lockQuery(Q.identity, []); const b = await q(Q.identity, []);
      if (a.rows.length !== 1 || b.length !== 1 || a.rows[0].db !== b[0].db || a.rows[0].environment !== c.dbEnvironment || b[0].environment !== c.dbEnvironment) return stop("SCOPE_REFUSED:POOLS_MISMATCH");
      const role = await q(Q.role, []);
      if (role.length !== 1 || role[0].privileged !== false || role[0].is_app !== true) return stop("SCOPE_REFUSED:ROLE_NOT_APP");
    } catch (e) { return e instanceof Stopped || e instanceof DbTimeout ? stop(`STOP_${stopReason ?? e.code}`) : stop("DB_ERROR:LOCK_QUERY_FAILED"); }

    // ---- (4) the target-only transport fence (Stripe + Hostaway), counters BEFORE the transport ---------------------------------------------------
    const bound = { resId: null, rid: null, res: null, cap: null, rec: null };
    const urls = { account: `${STRIPE}/v1/account`, pi: `${STRIPE}/v1/payment_intents/${PI}?expand%5B%5D=latest_charge`, capture: `${STRIPE}/v1/payment_intents/${PI}/capture`,
      listing: `${HOSTAWAY}/v1/listings/${c.listingId}`, price: `${HOSTAWAY}/v1/listings/${c.listingId}/calendar/priceDetails`, create: `${HOSTAWAY}/v1/reservations` };
    const CAPTURE_BODY = `amount_to_capture=${plan.amountMinor}&expand%5B%5D=latest_charge`;
    const fence = { createOpen: false, captureOpen: false, recordOpen: false, createExchanged: false, captureExchanged: false, recordExchanged: false };
    const hkeys = (h) => Object.keys(h).sort().join(",");
    const reject = () => { r.refusedAtTransport += 1; return Promise.reject(new Error("gate")); };
    const stripeGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || req.headers["Stripe-Version"] !== c.stripeVersion || r.exchanges >= B.exchanges) return reject();
      const isGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Authorization,Stripe-Version";
      const isCapture = req.method === "POST" && req.url === urls.capture && hkeys(req.headers) === "Authorization,Content-Type,Idempotency-Key,Stripe-Version"
        && req.headers["Idempotency-Key"] === plan.captureIdempotencyKey && req.headers["Content-Type"] === "application/x-www-form-urlencoded" && req.body === CAPTURE_BODY;
      if (isGet && req.url === urls.account && r.accountReads < B.accountReads) r.accountReads += 1;
      else if (isGet && req.url === urls.pi && r.piReads < B.piReads) r.piReads += 1;
      else if (isCapture && fence.captureOpen && !fence.captureExchanged) fence.captureExchanged = true;     // the ONE capture: exact URL / method / headers / body / key
      else return reject();                                                                              // no other Stripe write, ever
      r.exchanges += 1;
      return exchanges.stripe(req);
    };
    const parseUrl = (url) => { try { return new URL(url); } catch { return null; } };
    const isLookupUrl = (url) => {
      const u = parseUrl(url);
      if (!u || u.origin !== HOSTAWAY || u.pathname !== "/v1/reservations" || u.hash !== "") return false;
      const keys = [...u.searchParams.keys()];
      if (new Set(keys).size !== keys.length) return false;
      const base = ["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"];
      const sorted = [...keys].sort().join(",");
      if (sorted !== base.join(",") && sorted !== ["afterId", ...base].sort().join(",")) return false;
      const g = (k) => u.searchParams.get(k);
      return g("listingId") === String(c.listingId) && g("channelId") === "2000" && g("arrivalStartDate") === intent0.from && g("arrivalEndDate") === intent0.from
        && g("limit") === "100" && g("includeResources") === "1" && (!u.searchParams.has("afterId") || RID_RE.test(g("afterId")));
    };
    const isCalendarUrl = (url) => {
      const u = parseUrl(url);
      if (!u || u.origin !== HOSTAWAY || u.pathname !== `/v1/listings/${c.listingId}/calendar` || u.hash !== "") return false;
      return [...u.searchParams.keys()].sort().join(",") === "endDate,startDate" && u.searchParams.get("startDate") === intent0.from && u.searchParams.get("endDate") === intent0.to;
    };
    const boundRid = () => bound.rid ?? bound.resId;
    const isReservationUrl = (url) => {
      const m = /^https:\/\/api\.hostaway\.com\/v1\/reservations\/([1-9][0-9]{0,15})$/.exec(url);
      return !!m && !c.protectedReservationIds.includes(m[1]) && boundRid() !== null && m[1] === boundRid();     // ONLY the bound id (never adopted from a reply)
    };
    const createBodyOk = (body) => {
      let x; try { x = JSON.parse(body); } catch { return false; }
      if (!isObj(x) || body.includes("forceOverbooking")) return false;
      const cf = x.customFieldValues;
      return x.listingMapId === c.listingId && x.channelId === 2000 && x.arrivalDate === intent0.from && x.departureDate === intent0.to && x.numberOfGuests === intent0.guests
        && x.totalPrice === exactAmount(plan.amountMinor) && x.currency === c.currency && Array.isArray(cf) && cf.length === 1 && isObj(cf[0])
        && cf[0].customFieldId === c.refFieldId && cf[0].value === plan.ref;
    };
    const recordBodyOk = (body) => {
      let x; try { x = JSON.parse(body); } catch { return false; }
      if (!isObj(x) || Object.keys(x).sort().join(",") !== "amount,paymentMethod,scheduledDate,status,title") return false;
      return x.title === plan.title && x.amount === plan.amount && x.paymentMethod === c.paymentMethod && x.status === "paid" && typeof x.scheduledDate === "string" && x.scheduledDate.length <= 40;
    };
    const hostawayGate = (req) => {
      if (stopped()) { r.refusedByStop += 1; return Promise.reject(new Error("stopped")); }
      if (!req || !req.headers || r.exchanges >= B.exchanges) return reject();
      const plainGet = req.method === "GET" && req.body === null && hkeys(req.headers) === "Accept,Authorization,Cache-control";
      const postHdr = hkeys(req.headers) === "Accept,Authorization,Cache-control,Content-Type";
      const rid = boundRid();
      const listUrl = rid ? `${HOSTAWAY}/v1/guestPayments/charges?limit=500&reservationIds=${rid}` : null;
      const recordUrl = bound.rid ? `${HOSTAWAY}/v1/guestPayments/charges/${bound.rid}` : null;
      const isPrice = req.method === "POST" && req.url === urls.price && postHdr && typeof req.body === "string" && !req.body.includes("forceOverbooking");
      const isCreate = req.method === "POST" && req.url === urls.create && postHdr && typeof req.body === "string" && createBodyOk(req.body);
      const isRecord = req.method === "POST" && recordUrl !== null && req.url === recordUrl && postHdr && typeof req.body === "string" && recordBodyOk(req.body);
      if (plainGet && (req.url === urls.listing || isCalendarUrl(req.url)) && r.pricingCalls < B.pricingCalls) r.pricingCalls += 1;
      else if (isPrice && r.pricingCalls < B.pricingCalls) r.pricingCalls += 1;
      else if (plainGet && isReservationUrl(req.url) && r.hostawayReads < B.hostawayReads) r.hostawayReads += 1;
      else if (plainGet && isLookupUrl(req.url) && r.lookupPages < B.lookupPages) r.lookupPages += 1;
      else if (plainGet && listUrl !== null && req.url === listUrl && r.chargeLists < B.chargeLists) r.chargeLists += 1;
      else if (isCreate && fence.createOpen && !fence.createExchanged) fence.createExchanged = true;
      else if (isRecord && fence.recordOpen && !fence.recordExchanged) fence.recordExchanged = true;
      else return reject();
      r.exchanges += 1;
      return exchanges.hostaway(req);
    };
    const ts = tooling.createStripeSend({ exchange: stripeGate, credential: credentials.stripe, accountId: c.accountId, apiVersion: c.stripeVersion });
    const th = tooling.createHostawaySend({ exchange: hostawayGate, credential: credentials.hostaway });
    if (!ts || ts.ok !== true || !th || th.ok !== true) return stop("CORE_INVALID:TRANSPORT_INVALID");
    const composed = (sig) => {
      const parts = [stopAc.signal];
      if (sig instanceof AbortSignal) parts.push(sig);
      if (input.runSignal instanceof AbortSignal) parts.push(input.runSignal);
      parts.push(AbortSignal.timeout(Math.max(1, Math.floor(deadlineAt + B.teardownMs - now()))));
      return AbortSignal.any(parts);
    };
    const o2 = (opts) => ({ ...(isObj(opts) ? opts : {}), signal: composed(opts && opts.signal) });
    // the THREE write sends: counted and fenced BEFORE the transport (never a second send; a lost reply = UNKNOWN, never success)
    const writeSend = (slot, fenceKey, transport) => async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (r.sends[slot] >= B[slot]) { r.refusedAtTransport += 1; throw new Error(`${slot} budget`); }
      r.sends[slot] += 1; fence[`${fenceKey}Open`] = true;
      try {
        const out = await transport.send(req, o2(opts));
        r.replies[slot] = out && typeof out === "object" ? "REPLIED" : "UNKNOWN";
        return out;
      } catch (e) { r.replies[slot] = fence[`${fenceKey}Exchanged`] ? "UNKNOWN" : "NOT_SENT"; throw e; }
      finally { fence[`${fenceKey}Open`] = false; }
    };
    const sendCreate = writeSend("create", "create", th.transport);
    const sendRecord = writeSend("record", "record", th.transport);
    const sendCapture = writeSend("capture", "capture", ts.transport);
    const hostawaySend = async (req, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (req && req.method === "POST" && req.path === "/v1/reservations") return sendCreate(req, opts);
      if (req && req.method === "POST" && bound.rid && req.path === `/v1/guestPayments/charges/${bound.rid}`) return sendRecord(req, opts);
      if (!req || !(req.method === "GET" || (req.method === "POST" && /\/calendar\/priceDetails$/.test(String(req.path))))) { r.refusedAtTransport += 1; throw new Error("method refused"); }
      return th.transport.send(req, o2(opts));
    };
    const stripeSend = async (call, opts) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      if (call && call.op === "paymentIntents.capture") return sendCapture(call, opts);
      if (!call || !(call.op === "accounts.retrieve" || call.op === "paymentIntents.retrieve")) { r.refusedAtTransport += 1; throw new Error("op refused"); }
      return ts.transport.send(call, o2(opts));
    };

    // ---- (5) fresh read-only Stripe proof + Hostaway bound-reservation echo proof (runner reads; never persisted) -----------------------------------
    const freshProof = async (kind, label, intentNow) => {
      guard();
      let acct; let pi;
      try {
        acct = await supervise(ts.transport.send({ op: "accounts.retrieve" }, { signal: composed(null) }));
        guard();
        pi = await supervise(ts.transport.send({ op: "paymentIntents.retrieve", id: PI, params: { expand: ["latest_charge"] } }, { signal: composed(null) }));
      } catch (e) { if (e instanceof Stopped || stopped()) throw new Stopped(); return "READ_FAILED"; }
      if (!acct || acct.object !== "account" || acct.id !== c.accountId) return "ACCOUNT";
      const k = proofRefusal(kind, pi, intentNow, attemptId, tooling, clock());
      if (k) return k;
      r.proofs.push(label);
      return null;
    };
    const adapterConfig = tooling.validateAdapterConfig({ allowedListingIds: [c.listingId], refFieldId: c.refFieldId, channelId: 2000, currency: c.currency });
    const echoProof = async (rid, intentNow) => {
      guard();
      let rr;
      try { rr = await supervise(th.transport.send({ method: "GET", path: `/v1/reservations/${rid}`, query: {} }, { signal: composed(null) })); }
      catch (e) { if (e instanceof Stopped || stopped()) throw new Stopped(); return "RESERVATION_READ_FAILED"; }
      if (!rr || rr.httpStatus !== 200) return `RESERVATION_READ_${Number.isSafeInteger(rr && rr.httpStatus) ? rr.httpStatus : "FAILED"}`;
      const env = tooling.unwrapEnvelope(rr.json);
      if (!env || env.ok !== true) return "RESERVATION_ENVELOPE";
      const nr = tooling.normalizeReservation(env.result, adapterConfig);
      if (!nr || nr.ok !== true) return "RESERVATION_MALFORMED";
      const x = nr.reservation;
      // the ACCEPTED recording worker requires the booking ref ECHOED on the reservation (it has no by-ref lookup) — refused HERE, before its admission
      if (x.bookingRef !== plan.ref) return "REF_NOT_ECHOED";
      if (String(x.reservationId) !== rid || x.listingId !== c.listingId || x.channelId !== 2000 || x.from !== intentNow.from || x.to !== intentNow.to
          || x.totalMinor !== plan.amountMinor || x.currency !== c.currency || x.status === "cancelled") return "RESERVATION_NOT_BOUND";
      r.proofs.push("ECHO_BEFORE_RECORDING");
      return null;
    };

    // ---- (6) late-bound accepted executors (bound ONLY at their boundary, to the durable id; proxies keep the exact accepted key sets) --------------
    let guest;
    try {
      const g = await q(Q.guest, [IID]);
      if (g.length !== 1 || typeof g[0].email !== "string" || typeof g[0].first_name !== "string" || typeof g[0].last_name !== "string") return stop("ADMISSION_REFUSED:GUEST_NOT_FOUND");
      guest = freeze({ email: g[0].email, firstName: g[0].first_name, lastName: g[0].last_name });
    } catch (e) { return e instanceof Stopped || e instanceof DbTimeout ? stop(`STOP_${stopReason ?? e.code}`) : stop("DB_ERROR:GUEST_READ_FAILED"); }
    const LABEL = freeze({ accountRef: c.accountRef, clientSnapshotId: runId });
    const bindReservation = (id) => {
      const bx = tooling.createPhaseExecutors({ phase: id === null ? "reservation" : "reservation-recovery", binding: { listingId: c.listingId, arrivalDate: intent0.from,
        departureDate: intent0.to, ref: plan.ref, guests: intent0.guests, totalMinor: plan.amountMinor, currency: c.currency, refFieldId: c.refFieldId, guest, reservationId: id },
        hostaway: { send: hostawaySend } });
      if (!bx || bx.ok !== true) throw new HookStop("EXECUTOR_BINDING_REFUSED");
      bound.res = bx.executors; bound.resId = id;
    };
    const bindCapture = (rid) => {
      const bx = tooling.createPhaseExecutors({ phase: "capture", binding: { listingId: c.listingId, arrivalDate: intent0.from, departureDate: intent0.to, ref: plan.ref,
        reservationId: rid, accountId: c.accountId, paymentIntentId: PI, amountMinor: plan.amountMinor, captureIdempotencyKey: plan.captureIdempotencyKey },
        hostaway: { send: hostawaySend }, stripe: { send: stripeSend } });
      if (!bx || bx.ok !== true) throw new HookStop("EXECUTOR_BINDING_REFUSED");
      bound.cap = bx.executors; bound.rid = rid;
    };
    const bindRecording = (rid) => {
      const bx = tooling.createPhaseExecutors({ phase: "recording", binding: { listingId: c.listingId, reservationId: rid, intentId: IID, amountMinor: plan.amountMinor,
        paymentMethod: c.paymentMethod, accountRef: c.accountRef, clientSnapshotId: runId }, hostaway: { send: hostawaySend } });
      if (!bx || bx.ok !== true || canonical(bx.executors.label) !== canonical(LABEL)) throw new HookStop("EXECUTOR_BINDING_REFUSED");
      bound.rec = bx.executors; bound.rid = rid;
    };
    const via = (slot, key, sub = null) => async (...a) => {
      if (stopped()) { r.refusedByStop += 1; throw new Error("stopped"); }
      const ex = bound[slot]; const fn = ex ? (sub ? ex[key] && ex[key][sub] : ex[key]) : null;
      if (typeof fn !== "function") { r.refusedAtTransport += 1; throw new Error("executor unbound"); }      // never reached: every boundary binds or STOPs
      return Reflect.apply(fn, sub ? ex[key] : undefined, a);
    };
    const proxies = {
      reservation: freeze({ pricing: freeze({ get: via("res", "pricing", "get"), post: via("res", "pricing", "post") }), lookupPage: via("res", "lookupPage"),
        retrieveReservation: via("res", "retrieveReservation"), createReservation: via("res", "createReservation") }),
      capture: freeze({ retrieveAccount: via("cap", "retrieveAccount"), retrievePaymentIntent: via("cap", "retrievePaymentIntent"), capturePaymentIntent: via("cap", "capturePaymentIntent"),
        retrieveReservation: via("cap", "retrieveReservation"), lookupPage: via("cap", "lookupPage") }),
      recording: freeze({ label: LABEL, retrieveReservation: via("rec", "retrieveReservation"), listOfflineCharges: via("rec", "listOfflineCharges"),
        createOfflineCharge: via("rec", "createOfflineCharge") })
    };
    /** bind(facts, stateBefore) — the boundary logic, shared by the start and hooks.afterStep (throws HookStop / Stopped) */
    const bind = async (fx, stateBefore) => {
      const i = fx.intent;
      const k = checkPending(fx, plan, c);
      if (k && i && i.status !== "confirmed") throw new HookStop(`FACTS_${k}`);
      const cand = candidateOf(fx, c);
      if (!cand.ok) throw new HookStop(cand.code);
      if (i.status === "payment_authorized" || i.status === "reservation_pending") {
        if (bound.res === null || bound.resId !== cand.id) bindReservation(cand.id);
        return;
      }
      if (i.status === "reservation_confirmed") {
        if (cand.id === null || !i.reservation || String(i.reservation.reservationId) !== cand.id) throw new HookStop("RESERVATION_NOT_BOUND");
        if (bound.cap !== null && bound.rid === cand.id && stateBefore === "reservation_confirmed") return;
        const p = await freshProof("authorized", "STRIPE_BEFORE_CAPTURE", i);
        if (p) throw new HookStop(`FRESH_PROOF_${p}`);
        bindCapture(cand.id);
        return;
      }
      if (i.status === "payment_captured") {
        if (cand.id === null || !i.reservation || String(i.reservation.reservationId) !== cand.id) throw new HookStop("RESERVATION_NOT_BOUND");
        if (bound.rec !== null && bound.rid === cand.id && stateBefore === "payment_captured") return;
        const p = await freshProof("captured", "STRIPE_BEFORE_RECORDING", i);
        if (p) throw new HookStop(`FRESH_PROOF_${p}`);
        bound.rid = cand.id;                                                                            // admits the bound GET for the echo proof
        const e = await echoProof(cand.id, i);
        if (e) throw new HookStop(`ECHO_PROOF_${e}`);
        bindRecording(cand.id);
        return;
      }
      if (i.status === "confirmed") return;
      throw new HookStop(`STATE_${String(i.status).toUpperCase()}`);
    };

    // ---- (7) the START proof (BEFORE any coordinator / worker / provider write) and the start binding --------------------------------------------
    try {
      const kind = intent0.status === "payment_captured" ? "captured" : "authorized";
      const p = await freshProof(kind, "STRIPE_AT_START", intent0);
      if (p) return stop(`PROVIDER_PROOF_FAILED:${p}`);
      await bind(f, null);
    } catch (e) {
      if (e instanceof Stopped || stopped()) return stop(`STOP_${stopReason ?? "STOPPED"}`);
      return stop(e instanceof HookStop ? `PROVIDER_PROOF_FAILED:${e.code}` : "CORE_INVALID:START_BIND");
    }

    // ---- (8) the ONE coordinator invocation; hooks.afterStep: lock proof + facts + the boundary re-proofs / late binding ---------------------------
    const afterStep = async (step) => {
      if (stopped()) throw new Stopped();
      if (!(await ownLock())) { r.lock = "lost"; throw new HookStop(lockErrored ? "LOCK_SESSION_ERROR" : r.lockSession === "backend_hop" ? "BACKEND_HOP" : "LOCK_LOST"); }
      if (r.sends.create + r.sends.capture + r.sends.record > 0 && Object.values(r.replies).includes("UNKNOWN")) throw new HookStop("WRITE_REPLY_UNKNOWN");
      let fx;
      try { fx = await read(); } catch (e) { if (e instanceof Stopped || r.sealed) throw new Stopped(); throw new HookStop("FACTS_READ_FAILED"); }
      observe(fx);
      if (!fx.intent || fx.intent.status !== step.stateAfter) throw new HookStop("FACTS_STATE_DIVERGED");
      await bind(fx, step.stateBefore);
    };
    const workerEnv = freeze({ VERCEL_ENV: "development", MV_E7_TEST_PIPELINE_COORDINATOR: "enabled", MV_E7_RESERVATION_WORKER: "enabled", MV_E7_CAPTURE_WORKER: "enabled",
      MV_E7_RECORDING_WORKER: "enabled", DIRECT_DISCOUNT_BPS: String(rate) });
    const listingsBase = new Map([[c.listingId, { currency: c.currency, timeZone: c.listingTimeZone }]]);
    const recCfg = freeze({ accountRef: c.accountRef, channelId: 2000, currency: c.currency, listingId: c.listingId, paymentMethod: c.paymentMethod, refFieldId: c.refFieldId });
    if (stopped()) return stop(`STOP_${stopReason}`);
    let co;
    try {
      if (!(await ownLock())) { r.lock = "lost"; return stop("LOCK_LOST:BEFORE_COORDINATOR"); }
      if (stopped()) return stop(`STOP_${stopReason}`);
      r.coordinatorInvocations += 1;                                                                    // exactly ONE; there is no loop around it
      coordinatorAdmitted = true;
      coP = Promise.resolve().then(() => tooling.runTestPipelineCoordinator(countedPool, { workerId: `e7-hpl:${plan.approvalRef.slice(0, 40)}`, env: workerEnv, binding: { intentId: IID, ref: plan.ref },
        phases: { reservation: { adapterConfig, listings: listingsBase, executors: proxies.reservation },
          capture: { adapterConfig, listings: listingsBase, executors: proxies.capture, stripeAccountId: c.accountId },
          recording: { listings: new Map([[c.listingId, recCfg]]), executors: proxies.recording } },
        clock, recordingClock, now, maxSteps: B.maxSteps, deadlineAt, signal: stopAc.signal, hooks: { afterStep } }));
      co = await supervise(coP);                                                                        // sealed: rejects; the sealed coordinator can no longer reach DB / provider
    } catch (e) {
      if (r.sealed) return stop(`STOP_${stopReason}`);
      if (e instanceof Refusal && e.code === "DB_BUDGET") return stop("BUDGET_EXHAUSTED:DB_QUERY_CEILING");
      return stop("COORDINATOR_THREW");
    }
    r.coordinator = co && typeof co === "object" ? freeze({ outcome: code(co.outcome, "INVALID"), code: code(co.code, "INVALID"),
      steps: Array.isArray(co.steps) ? co.steps.slice(0, 16).map((s) => freeze({ phase: code(s.phase, "-"), status: code(s.status, "-"), stateBefore: code(s.stateBefore, "-"), stateAfter: code(s.stateAfter, "-") })) : [],
      writes: co.writes && typeof co.writes === "object" ? freeze({ create: Number(co.writes.create) || 0, capture: Number(co.writes.capture) || 0, record: Number(co.writes.record) || 0 }) : null,
      nextActionAt: Number.isSafeInteger(co.nextActionAt) ? co.nextActionAt : null }) : null;
    const attempted = () => r.sends.create + r.sends.capture + r.sends.record + (r.coordinator && r.coordinator.writes ? r.coordinator.writes.create + r.coordinator.writes.capture + r.coordinator.writes.record : 0);
    if (!r.coordinator) return stop("COORDINATOR_INVALID_RESULT");

    // ---- (9) durable readback: ONLY a verified CONFIRMED is success; PENDING is reported over settled facts; anything else STOPS -------------------
    let fz;
    try { fz = await read(); } catch (e) { return stop(r.sealed ? `STOP_${stopReason}` : "POSTCHECK_MISMATCH:READBACK_FAILED"); }
    observe(fz);
    if (r.coordinator.outcome === "CONFIRMED") {
      const pe = checkEnd(fz, plan, c);
      if (pe) return stop(`POSTCHECK_MISMATCH:${pe}`);
      if (stopped()) return stop(`STOP_${stopReason}`);
      r.postcheck = freeze({ state: "confirmed", create: 1, capture: 1, record: 1, capturedMinor: plan.amountMinor, offlineChargeId: r.offlineChargeId, claimHeld: true, openCases: 0 });
      r.verifiedCompletion = true;
      return done("CONFIRMED_VERIFIED", "CONFIRMED");
    }
    if (r.coordinator.outcome === "PENDING") {
      const pk = checkPending(fz, plan, c);
      if (pk) return stop(`PENDING_FACTS_${pk}`);
      if (Object.values(r.replies).includes("UNKNOWN")) return stop("PENDING_FACTS_WRITE_REPLY_UNKNOWN");
      const at = sanitizeNextActionAt(r.coordinator.nextActionAt, clock(), B.pendingHorizonMs);
      if (at === null) return stop(`PENDING_NEXT_ACTION_INVALID:${r.coordinator.code}`);
      r.nextActionAt = at;
      return done("PENDING", `PENDING:${r.coordinator.code}`);
    }
    if (attempted() > 0) r.possiblyEffected = true;
    return stop(`COORDINATOR_${r.coordinator.outcome}:${r.coordinator.code}`);
  };
  const bounded = (p, ms) => new Promise((resolve) => { let t = null; const fin = (v) => { try { clearT(t); } catch { /* ignore */ } resolve(v); };
    t = setT(() => fin({ done: false }), ms, "teardown"); Promise.resolve().then(() => p).then((value) => fin({ done: true, value }), () => fin({ done: true, threw: true })); });
  const bodyP = Promise.resolve().then(() => body());
  try {
    const out = await supervise(bodyP);                                                                // the body itself is inside the seal too
    if (out !== DONE) stop("INTERNAL");
  } catch (e) {
    if (r.sealed) {
      stop(`STOP_${stopReason}`); finalized = true;                                                     // the seal decides; nothing after it can turn this into success
      await bounded(bodyP, B0.teardownMs);                                                              // let the sealed body unwind (all its awaits are already rejecting)
    } else stop(e instanceof Refusal && e.code === "DB_BUDGET" ? "BUDGET_EXHAUSTED:DB_QUERY_CEILING" : "INTERNAL");
  } finally {
    finalized = true;
    if (timerHandle !== null) { try { clearT(timerHandle); } catch { /* ignore */ } }
    if (coP !== null) { const s2 = await bounded(coP, B0.teardownMs); r.coordinatorSettled = s2.done === true; }
    if (r.sealed && r.outcome !== "STOP") { r.outcome = "STOP"; r.code = code(`STOP_${stopReason}`, "STOP_SEALED"); r.verifiedCompletion = false; r.postcheck = null; r.nextActionAt = null; }
    if (lockT) {
      let released = false;
      if (lockAcquired && !lockErrored && !r.sealed && !lockT.released) {
        const u = await bounded(supervise(lockT.cl.query("SELECT pg_advisory_unlock(pg_catalog.hashtext($1), 0) AS ok, pg_catalog.pg_backend_pid() AS pid", [input?.tooling?.LOCK_KEY ?? ""]),
          B0.statementMs, () => destroy(lockT)), B0.teardownMs);
        released = u.done && !u.threw && u.value && u.value.rows && u.value.rows.length === 1 && u.value.rows[0].ok === true && String(u.value.rows[0].pid) === lockPid && !lockErrored;
      }
      if (lockAcquired) r.lock = released ? "released" : (lockErrored ? "session_error_connection_destroyed" : r.sealed ? "sealed_connection_destroyed" : "unlock_failed_connection_destroyed");
      if (released) finish(lockT, false); else destroy(lockT);
      if (lockAcquired && !released && r.outcome === "CONFIRMED_VERIFIED") { r.outcome = "STOP"; r.code = "UNLOCK_NOT_PROVEN"; r.verifiedCompletion = false; }
    }
    for (const t of [...tracked]) destroy(t);                                                           // no connection outlives the core
    const attempted = r.sends.create + r.sends.capture + r.sends.record;
    if (r.outcome === "STOP" && (attempted > 0 || r.dbOutcomeUnknown)) r.possiblyEffected = true;     // STOP after any attempted write or an UNKNOWN DB outcome
  }
  return freeze(JSON.parse(JSON.stringify(r)));
}

// =================================================================================================================================
// hosted wrapper (GitHub Actions): preflight (no secrets) / verify / execute (C92: OPENED; closed constants refuse)
export const CLOSURE_DIGEST_PREFIX = "e7-hosted-pipeline-closure-v1\n";
export const SOURCE_DIGEST_PREFIX = "e7-hosted-pipeline-v1\n";
const TEST_FILES = freeze(["test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs"]);
const SECRET_KEYS = freeze(["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]);
export const INPUT_ENV = freeze({ approvalRef: "E7_APPROVAL_REF", intentId: "E7_INTENT_ID", ref: "E7_BOOKING_REF", expectedVersion: "E7_EXPECTED_VERSION",
  notBefore: "E7_NOT_BEFORE", paymentIntentId: "E7_PAYMENT_INTENT_ID", amountMinor: "E7_AMOUNT_MINOR", currency: "E7_CURRENCY" });
export const ALLOWED_E7_KEYS = freeze([...Object.values(INPUT_ENV), "E7_TOOLING_DIR", "E7_EXPECTED_PLAN_HASH", "E7_EXPECTED_SOURCE_DIGEST", "E7_EXPECTED_CLOSURE_DIGEST",
  "E7_WORKFLOW_SHA", "E7_RUN_ID", "E7_CA_FILE", ...SECRET_KEYS]);

/** runHosted({ mode, env, proc, wrapperDir, deps }) → { exitCode, result }. Never throws. deps = TEST SEAMS (constants included). */
export async function runHosted({ mode = "preflight", env, proc, wrapperDir, deps = {} }) {
  const c = deps.constants ?? CONSTANTS;
  const r = { schema: "e7-hosted-pipeline-hosted-v1", mode: null, code: null, workflowSha: null, toolingCommit: c.toolingCommit, executeEnabled: c.executeEnabled,
    closureDigest: null, sourceDigest: null, planKind: null, planHash: null, runId: null, envCode: null, tests: null, lockEndpoint: null, core: null, cleanup: null };
  let pool = null; let lockPool = null;
  try {
    if (!["preflight", "verify", "execute"].includes(mode)) refuse("HPL_USAGE");
    r.mode = mode;
    const keys = Object.keys(env);                                         // key NAMES only — no value is read before the next two gates
    if (keys.some((k) => k.startsWith("E7_") && !ALLOWED_E7_KEYS.includes(k))) refuse("HPL_INPUT_UNEXPECTED");
    if (mode !== "preflight" && c.executeEnabled !== true) refuse("HPL_EXECUTE_CLOSED");   // CLOSED constants refuse HERE — before any value / import / credential / DB / provider
    const spawnChild = deps.spawnChild ?? spawnNode;
    const importEnv = deps.importEnv ?? ((dir) => import(pathToFileURL(`${dir}/scripts/e7-connected/probe-env-preflight.mjs`).href));
    const importTooling = deps.importTooling ?? defaultImportTooling;
    const runCore = deps.runCore ?? runPipelineCore;
    const readPgVersion = deps.readPgVersion ?? (async (dir) => JSON.parse(await readFile(`${dir}/node_modules/pg/package.json`, "utf8")).version);
    const readCa = deps.readCa ?? ((p) => readFile(p));
    r.workflowSha = HEX40.test(env.E7_WORKFLOW_SHA ?? "") ? env.E7_WORKFLOW_SHA : null;
    if (mode !== "execute" && SECRET_KEYS.some((k) => keys.includes(k))) refuse("HPL_SECRET_SCOPE_VIOLATION");
    const inp = {}; for (const k of PLAN_INPUT_KEYS) inp[k] = env[INPUT_ENV[k]] ?? "";
    const vals = PLAN_INPUT_KEYS.map((k) => inp[k]); const anyReal = vals.some((v) => v !== "");
    if (anyReal && vals.some((v) => v === "")) refuse("HPL_INPUT_INCOMPLETE");
    if (anyReal && (!APPROVAL_RE.test(inp.approvalRef) || !UUID_RE.test(inp.intentId) || !REF_RE.test(inp.ref) || !/^[1-9][0-9]{0,6}$/.test(inp.expectedVersion)
        || isoMs(inp.notBefore) === null || !PI_RE.test(inp.paymentIntentId) || !/^[1-9][0-9]{0,7}$/.test(inp.amountMinor) || inp.currency !== c.currency)) refuse("HPL_INPUT_INVALID");
    if (anyReal && (inp.approvalRef === c.synthetic.approvalRef || inp.intentId === c.synthetic.intentId || inp.paymentIntentId === c.synthetic.paymentIntentId)) refuse("HPL_INPUT_INVALID");
    if (anyReal && c.excludedIntentIds.includes(inp.intentId)) refuse("HPL_INTENT_EXCLUDED");
    if (anyReal && isoMs(inp.notBefore) < isoMs(c.historicalFloor)) refuse("HPL_INTENT_EXCLUDED");
    const expPlan = env.E7_EXPECTED_PLAN_HASH ?? ""; const expSrc = env.E7_EXPECTED_SOURCE_DIGEST ?? ""; const expClo = env.E7_EXPECTED_CLOSURE_DIGEST ?? "";
    const runId = env.E7_RUN_ID ?? "";
    if (mode !== "preflight") {
      if (c.toolingStatus !== "MERGED" || !HEX64.test(String(c.closureDigest))) refuse("HPL_CLOSURE_MISMATCH");
      if (!anyReal || !HEX64.test(expPlan) || !HEX64.test(expSrc) || !HEX64.test(expClo)) refuse("HPL_INPUT_INCOMPLETE");
      if (!RUN_ID_RE.test(runId)) refuse("HPL_INPUT_INVALID");
      if (env.GITHUB_REF !== "refs/heads/main") refuse("HPL_REF_NOT_MAIN");
      if (expClo !== c.closureDigest) refuse("HPL_CLOSURE_MISMATCH");
    }
    const tooling = await realpath(env.E7_TOOLING_DIR ?? "").catch(() => refuse("HPL_LAYOUT_INVALID"));
    const wdir = await realpath(wrapperDir).catch(() => refuse("HPL_LAYOUT_INVALID"));
    if (tooling === wdir || tooling.startsWith(`${wdir}/`) || wdir.startsWith(`${tooling}/`)) refuse("HPL_LAYOUT_INVALID");
    r.closureDigest = await framedDigest(tooling, c.closure, CLOSURE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HPL_SOURCE_UNREADABLE"));
    if (r.closureDigest !== c.closureDigest) refuse("HPL_CLOSURE_MISMATCH");             // the pinned bytes are verified BEFORE any tooling import
    r.sourceDigest = await framedDigest(wdir, c.runnerFiles, SOURCE_DIGEST_PREFIX).catch((e) => refuse(e instanceof Refusal ? e.code : "HPL_SOURCE_UNREADABLE"));
    if (mode !== "preflight" && r.sourceDigest !== expSrc) refuse("HPL_SOURCE_MISMATCH");
    r.planKind = anyReal ? "REAL" : "SYNTHETIC";
    const s = c.synthetic;
    const built = buildPlan(c, anyReal ? { ...inp, expectedVersion: Number(inp.expectedVersion), amountMinor: Number(inp.amountMinor), sourceDigest: r.sourceDigest }
      : { ...s, sourceDigest: r.sourceDigest });
    r.planHash = built.planHash;
    if (mode !== "preflight" && built.planHash !== expPlan) refuse("HPL_PLAN_HASH_MISMATCH");
    let C1; try { C1 = await importEnv(tooling); } catch { refuse("HPL_IMPORT_FAILED"); }
    const present = Object.fromEntries(C1.PRESENT_KEYS.map((k) => [k, Object.hasOwn(env, k)]));
    let uid = null; try { if (typeof proc.getuid === "function") { const u = proc.getuid(); if (Number.isSafeInteger(u) && u >= 0) uid = u; } } catch { uid = null; }
    const ev = C1.evaluateProbeEnvironment({ schema: C1.ENV_SNAPSHOT_SCHEMA, nodeVersion: String(proc.versions.node), platform: proc.platform,
      execArgvCount: proc.execArgv.length, uidAvailable: uid !== null, present });
    r.envCode = typeof ev.code === "string" && C1.ENV_CODES.includes(ev.code) ? ev.code : "REDACTED";
    if (ev.ok !== true || proc.versions.node !== c.nodeVersion) refuse("HPL_ENV_REFUSED");
    if (mode === "preflight") {
      const o = await spawnChild(["--test", "--test-reporter=tap", ...TEST_FILES], { cwd: wdir, env: childEnv(env, tooling) });
      if (!o || o.spawnFailed || (o.signal !== null && o.signal !== undefined) || !Number.isSafeInteger(o.status) || o.truncated) refuse("HPL_CHILD_FAILED");
      const num = (re) => { const m = re.exec(o.stdout); return m ? Number(m[1]) : null; };
      r.tests = { status: o.status, tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m), fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m) };
      if (o.status !== 0 || !(r.tests.tests > 0) || r.tests.pass !== r.tests.tests || r.tests.fail !== 0) refuse("HPL_TESTS_FAILED");
      r.code = anyReal ? "PREFLIGHT_OK_REAL_PLAN" : "PREFLIGHT_OK_SYNTHETIC_ONLY"; return { exitCode: 0, result: r };
    }
    if (mode === "verify") { r.code = "VERIFY_OK"; return { exitCode: 0, result: r }; }
    r.runId = runId;
    if (!SECRET_KEYS.every((k) => typeof env[k] === "string" && env[k].length > 0)) refuse("HPL_CREDENTIALS_MISSING");
    let skey = env.E7_STRIPE_TEST_KEY; delete env.E7_STRIPE_TEST_KEY;
    let htok = env.E7_HOSTAWAY_TOKEN; delete env.E7_HOSTAWAY_TOKEN;
    let dbUrl = env.E7_DEV_BOOKING_DATABASE_URL; delete env.E7_DEV_BOOKING_DATABASE_URL;
    let lockUrl = null;
    const wipe = () => { skey = null; htok = null; dbUrl = null; lockUrl = null; };
    try {
      let pgv; try { pgv = await readPgVersion(tooling); } catch { pgv = null; }
      if (pgv !== c.pgVersion) refuse("HPL_DEPENDENCY_MISMATCH");
      if (!dbTargetOk(dbUrl, c)) refuse("HPL_DB_TARGET_INVALID");
      lockUrl = sessionLockUrl(dbUrl, c);
      if (lockUrl === null) refuse("HPL_DB_TARGET_INVALID");
      let caPem = null;
      try { const b = await readCa(env.E7_CA_FILE ?? ""); if (b.length < 16384 && sha(b) === (deps.caSha256 ?? OFFICIAL_CA_SHA256)) caPem = b.toString("utf8"); } catch { caPem = null; }
      if (caPem === null) refuse("HPL_CA_INVALID");
      let mods; try { mods = await importTooling(tooling); } catch { refuse("HPL_IMPORT_FAILED"); }
      const xs = mods.X.createE7RealExchange({ provider: "stripe" }); const xh = mods.X.createE7RealExchange({ provider: "hostaway" });
      if (!xs || xs.ok !== true || !xh || xh.ok !== true) refuse("HPL_IMPORT_FAILED");
      try {
        pool = mods.createBookingPool({ connectionString: dbUrl, caPem, max: 3 });                       // worker pool: transaction pooler (6543)
        lockPool = mods.createBookingPool({ connectionString: lockUrl, caPem, max: 1 });                 // dedicated SESSION lock connection (5432)
      } catch { refuse("HPL_DB_TARGET_INVALID"); }
      dbUrl = null; lockUrl = null;
      r.lockEndpoint = `session:${SESSION_LOCK_PORT}`;
      const ac = new AbortController(); const onSig = () => ac.abort(); proc.once?.("SIGINT", onSig); proc.once?.("SIGTERM", onSig);
      const sk = skey; const ht = htok;
      try {
        r.core = await runCore({ plan: built.plan, pool, lockClientFactory: () => lockPool.connect(), tooling: mods.tooling, exchanges: { stripe: xs.exchange, hostaway: xh.exchange },
          credentials: { stripe: () => sk, hostaway: () => ht }, runId, runSignal: ac.signal });
      } finally { proc.off?.("SIGINT", onSig); proc.off?.("SIGTERM", onSig); }
    } finally { wipe(); }
    r.code = "EXECUTE_DONE";
    const ok = r.core && ((r.core.outcome === "CONFIRMED_VERIFIED" && r.core.verifiedCompletion === true) || (r.core.outcome === "PENDING" && typeof r.core.nextActionAt === "string"));
    return { exitCode: ok ? 0 : 1, result: r };
  } catch (e) {
    r.code = e instanceof Refusal && HOSTED_CODES.includes(e.code) ? e.code : "HPL_INTERNAL";
    return { exitCode: 1, result: r };
  } finally {
    const end = async (p) => { if (!p) return true; try { await Promise.race([p.end(), new Promise((_, rej) => setTimeout(() => rej(new Error("t")), 5000))]); return true; } catch { return false; } };
    if (pool || lockPool) { const a = await end(lockPool); const b = await end(pool); r.cleanup = a && b ? "POOLS_ENDED" : "POOL_END_FAILED"; }
  }
}
export async function defaultImportTooling(dir) {
  const u = (p) => pathToFileURL(`${dir}/${p}`).href;
  const [CO, R, EA, T, X, P, HR, CP, RP, IS, LK] = await Promise.all([import(u("lib/booking-db/test-pipeline-coordinator.js")), import(u("lib/booking-db/repo.js")),
    import(u("scripts/e7-connected/executor-adapters.mjs")), import(u("scripts/e7-connected/http-transports.mjs")), import(u("scripts/e7-connected/real-exchange.mjs")),
    import(u("lib/booking-db/pool.js")), import(u("lib/hostaway-reservations.js")), import(u("lib/checkout/capture-proof.js")), import(u("lib/checkout/recovery-plan.js")),
    import(u("lib/checkout/intent-state.js")), import(u("scripts/e7-connected/run-lock-precheck.mjs"))]);
  return { X, createBookingPool: P.createBookingPool,
    tooling: freeze({ runTestPipelineCoordinator: CO.runTestPipelineCoordinator, refundObservationRefusal: CO.refundObservationRefusal, loadIntent: R.loadIntent,
      createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend, createHostawaySend: T.createE7HostawaySend,
      validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
      paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCapturedProof: RP.piCapturedProof,
      captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL }) };
}
export function summaryMarkdown(r) {
  const k = r.core ? ` core=${r.core.outcome}/${r.core.code ?? "-"} coordinator=${r.core.coordinator ? `${r.core.coordinator.outcome}/${r.core.coordinator.code}` : "-"} sends=${r.core.sends.create}/${r.core.sends.capture}/${r.core.sends.record} replies=${r.core.replies.create}/${r.core.replies.capture}/${r.core.replies.record} verifiedCompletion=${r.core.verifiedCompletion === true} possiblyEffected=${r.core.possiblyEffected === true} nextActionAt=${r.core.nextActionAt ?? "-"} lock=${r.core.lock}` : "";
  return `e7-hosted-pipeline ${r.mode} ${r.code} executeEnabled=${r.executeEnabled} lock=${r.lockEndpoint ?? "-"} plan=${r.planKind ?? "-"}:${r.planHash ?? "-"} runId=${r.runId ?? "-"} closure=${r.closureDigest ?? "-"} source=${r.sourceDigest ?? "-"} cleanup=${r.cleanup ?? "-"}${k}\n`;
}

// ---- the ONLY top-level effect -----------------------------------------------------------------------------------------------------
if (import.meta.main === true) {
  const mode = process.argv[2];
  const wrapperDir = fileURLToPath(new URL("../", import.meta.url));
  runHosted({ mode, env: process.env, proc: process, wrapperDir }).then(({ exitCode, result }) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof process.env.GITHUB_STEP_SUMMARY === "string" && process.env.GITHUB_STEP_SUMMARY.length > 0) {
      import("node:fs/promises").then((fs) => fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result))).catch(() => {}).finally(() => process.exit(exitCode));
    } else process.exit(exitCode);
  }).catch(() => process.exit(1));
}
