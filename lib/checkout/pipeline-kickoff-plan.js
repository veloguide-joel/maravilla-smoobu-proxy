// lib/checkout/pipeline-kickoff-plan.js — Stage E7 C107 (OFFLINE, pure): the EXACT workflow_dispatch input grammar and real plan hash of the
// reviewed hosted pipeline runner at ONE immutable reviewed ENABLE revision, for a server-bound kickoff request.
//
// PINNED REVISION (immutable): wrapper main 9455bc9e (#140, the C102 ENABLE tree f5eac3c1, ROOT GO 5913339514). The functions below are a
// LABELLED COPY of that revision's pure plan builder (scripts/e7-hosted-pipeline.mjs: canonical, offlineChargeTitle, exactAmount, buildPlan) and
// of the CONSTANTS fields buildPlan reads. Parity is not assumed: test/e7-c107-kickoff-plan.test.mjs reproduces ROOT's recorded C103 real plan
// hash 11c29542… from the C103 inputs (a known answer computed by the deployed revision) and, when the pinned revision's blob is present in the
// local git object store, compares buildPlan output byte-for-byte on a vector set. A different revision means new pins, not an edit here.
//
// C116 SOURCE REBIND (metadata only): the ENABLE runner + workflow BYTES are unchanged (runnerSha256 a5b9ebca / workflowSha256 3feeed15 ==
// 9455bc9e, so the copied plan builder and its constants are untouched). Only the ENABLE source FRAME changed, because the pipeline's own
// workflow test dropped its exact pin of the C50 notification runner (moved to main's cross-runner regression, outside every runtime frame,
// which breaks the C116 notification → pipeline → SQL literal → catalog cycle): f09bcbbd… (9455bc9e) → 880db5b3… = the reviewed C102 ENABLE
// delta applied to the C116 CLOSED pipeline frame cfe62d4d…. Migration 0026 binds the same literal in booking.claim_pipeline_kickoff.
// wrapperCommit / wrapperTree remain the plan-builder parity source (K2) and the transport's default pin; the kickoff runtime always passes
// an explicit release binding.
//
// No I/O, no environment, no secret, no network. Building inputs is not a dispatch; a dispatch is not an execution; HTTP acceptance of a
// dispatch is not a booking.
import { createHash } from "node:crypto";

const freeze = Object.freeze;
function deepFreeze(v) { if (v && typeof v === "object") { for (const k of Object.keys(v)) deepFreeze(v[k]); freeze(v); } return v; }

const MIGRATED = [628346, 628372, 628373, 628374, 628375, 628376, 628377, 628378, 628379, 628380, 628382, 628383, 628384, 628385, 628386,
  628388, 628389, 628390, 628391, 628392, 628393, 628394, 628395, 628396, 628397, 628398, 628399, 628400];

/** the pinned reviewed ENABLE revision and the digests its workflow binds (expected_source_digest / expected_closure_digest) */
export const PINNED_REVISION = deepFreeze({
  wrapperCommit: "9455bc9ee15370b5321b7a04a96e893e9e80080b", wrapperTree: "f5eac3c1e31d0a9b90f841eac519a025dd6a444b",
  runnerPath: "scripts/e7-hosted-pipeline.mjs", runnerSha256: "a5b9ebca0c4b071f75d318357a8849070d9e2710b4ff652df8fa0ad4dc0cf7e7",
  workflowPath: ".github/workflows/e7-hosted-pipeline.yml", workflowFile: "e7-hosted-pipeline.yml",
  workflowSha256: "3feeed1588c091843c560815840ce98bd6d0fa335dc2acde37b3a42d81d3efbb",
  sourceDigest: "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b",   // C116 ENABLE frame (was f09bcbbd… at 9455bc9e)
  closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273"
});

/** LABELLED COPY: the CONSTANTS fields buildPlan reads at the pinned revision (values verbatim) */
export const PINNED_PLAN_CONSTANTS = deepFreeze({
  toolingCommit: "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5", executeEnabled: true,
  closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273",
  accountId: "acct_1TyHE42B9LTneQgw", stripeVersion: "2026-01-28.clover", listingId: 606998, currency: "USD", refFieldId: 105433,
  dbEnvironment: "test", dbProjectRef: "mxotevtiscernhqilyiu",
  protectedReservationIds: ["70636076", "71045356", "71072615", "71081885"],
  excludedIntentIds: ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
    "669da884-02e8-4105-8825-f908e5d22ae9"],
  historicalFloor: "2026-11-15T21:18:31.000Z",
  excludedListingIds: [...MIGRATED, 628381, 628387, 603564, 603566],
  paymentMethod: "credit_card", accountRef: "hostaway-e7-test",
  budgets: { coordinatorInvocations: 2, maxWaits: 1, maxWaitMs: 150000, continuationReserveMs: 180000, maxSteps: 6, create: 1, capture: 1, record: 1, accountReads: 8,
    piReads: 10, pricingCalls: 36, hostawayReads: 36, lookupPages: 24, chargeLists: 12, exchanges: 160, dbQueries: 1500, runMs: 12 * 60 * 1000, teardownMs: 5000,
    pendingHorizonMs: 7 * 24 * 60 * 60 * 1000, connectMs: 10000, statementMs: 30000 }
});

/** the kickoff scope (STRICTER than the pinned runner's own admission: a later cutoff and the C103 target excluded too) */
export const KICKOFF_SCOPE = deepFreeze({
  cutoff: "2026-11-15T22:58:01.000Z", listingId: 606998, currency: "USD",
  excludedIntentIds: [...PINNED_PLAN_CONSTANTS.excludedIntentIds, "1d6e770f-ba3d-40f7-92c1-ee01be7da532"],
  excludedListingIds: PINNED_PLAN_CONSTANTS.excludedListingIds
});

export class KickoffPlanRefusal extends Error { constructor(code) { super("pipeline-kickoff-plan"); this.code = code; } }
const refuse = (code) => { throw new KickoffPlanRefusal(code); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const ANY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PI_RE = /^pi_[A-Za-z0-9_]{1,250}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const APPROVAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isVersion = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1000000;
const isAmount = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 99999999;
const isoMs = (s) => (typeof s === "string" && ISO_RE.test(s) && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === (s.length === 20 ? `${s.slice(0, 19)}.000Z` : s) ? Date.parse(s) : null);

// ---- LABELLED COPY (pinned revision, verbatim semantics) ---------------------------------------------------------------------------------
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export const offlineChargeTitle = (intentId) => `maraVilla payment mvoch1-${intentId}`;
export const exactAmount = (minor) => { if (!isAmount(minor)) return null; const n = Number(`${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`); return Number.isFinite(n) ? n : null; };
export const PLAN_SCHEMA = "e7-hosted-pipeline-plan-v1";
export function buildPlan(c, { approvalRef, intentId, ref, expectedVersion, notBefore, paymentIntentId, amountMinor, currency, sourceDigest }) {
  if (typeof approvalRef !== "string" || !APPROVAL_RE.test(approvalRef) || typeof intentId !== "string" || !ANY_UUID_RE.test(intentId)) refuse("HPL_INPUT_INVALID");
  if (typeof ref !== "string" || !/^MV-[A-Z0-9]{6,10}$/.test(ref) || !isVersion(expectedVersion) || isoMs(notBefore) === null) refuse("HPL_INPUT_INVALID");
  if (typeof paymentIntentId !== "string" || !PI_RE.test(paymentIntentId) || !isAmount(amountMinor) || currency !== c.currency) refuse("HPL_INPUT_INVALID");
  if (typeof sourceDigest !== "string" || !HEX64.test(sourceDigest)) refuse("HPL_INPUT_INVALID");
  if (c.listingId !== 606998 || c.currency !== "USD" || c.dbEnvironment !== "test" || c.budgets.create !== 1 || c.budgets.capture !== 1 || c.budgets.record !== 1
      || c.budgets.coordinatorInvocations !== 2 || c.budgets.maxWaits !== 1 || !(c.budgets.maxWaitMs > 0 && c.budgets.maxWaitMs <= 150000)
      || c.budgets.maxSteps > 8 || c.excludedListingIds.includes(c.listingId)) refuse("HPL_INPUT_INVALID");       // code ceiling
  const plan = { schema: PLAN_SCHEMA, kind: "e7-test-pipeline-one-bound-intent", approvalRef, intentId, ref, expectedVersion, notBefore, paymentIntentId, amountMinor, currency,
    listingId: c.listingId, accountId: c.accountId, stripeVersion: c.stripeVersion, refFieldId: c.refFieldId, dbEnvironment: c.dbEnvironment, dbProjectRef: c.dbProjectRef,
    toolingCommit: c.toolingCommit, closureDigest: c.closureDigest, sourceDigest, historicalFloor: c.historicalFloor, excludedIntentIds: c.excludedIntentIds,
    protectedReservationIds: c.protectedReservationIds, paymentMethod: c.paymentMethod, accountRef: c.accountRef,
    captureIdempotencyKey: `cap:${intentId}:${paymentIntentId}`, recordingIdempotencyKey: `och:${intentId}:1`, title: offlineChargeTitle(intentId), amount: exactAmount(amountMinor),
    budgets: { ...c.budgets }, writes: { create: 1, capture: 1, record: 1, refund: 0, cancel: 0, void: 0, notify: 0, account: 0 },
    continuation: { maxCoordinatorInvocations: c.budgets.coordinatorInvocations, maxWaits: c.budgets.maxWaits, maxWaitMs: c.budgets.maxWaitMs,
      branch: "PENDING:NOT_DUE+reservation_pending+one_settled_create+no_capture_record", readmission: "fresh_durable_facts+same_version+refund_veto+fresh_stripe_proof+final_durable_reread_after_proof+no_active_hold+no_unprocessed_inbox" },
    executeEnabled: c.executeEnabled };
  return { plan: deepFreeze(plan), planHash: sha(canonical(plan)) };
}

// ---- the kickoff binding → the workflow's EXACT input grammar ------------------------------------------------------------------------------
/** the 12 workflow_dispatch inputs of the pinned workflow, in its declared order (all strings) */
export const WORKFLOW_INPUT_KEYS = freeze(["mode", "approval_ref", "intent_id", "booking_ref", "expected_version", "not_before", "payment_intent_id",
  "amount_minor", "currency", "expected_plan_hash", "expected_source_digest", "expected_closure_digest"]);
export const approvalRefFor = (ref, version) => `E7-KICKOFF-${ref}-v${version}`;

/**
 * kickoffDispatch(bound) → { inputs, planHash, approvalRef } — bound = SERVER facts of ONE request row:
 *   { intentId, ref, authorizedVersion, paymentIntentId, amountMinor, currency, listingId, notBefore (ISO ms, = the intent's created_at
 *     truncated to the millisecond, from the database) }. Refuses (KickoffPlanRefusal) on anything out of scope; never consults a client value.
 */
export function kickoffDispatch(bound, { scope = KICKOFF_SCOPE, revision = PINNED_REVISION, constants = PINNED_PLAN_CONSTANTS } = {}) {
  const b = bound;
  if (!b || typeof b !== "object") refuse("KICKOFF_BINDING_INVALID");
  if (typeof b.intentId !== "string" || !ANY_UUID_RE.test(b.intentId) || typeof b.ref !== "string" || !REF_RE.test(b.ref)) refuse("KICKOFF_BINDING_INVALID");
  if (!isVersion(b.authorizedVersion) || typeof b.paymentIntentId !== "string" || !PI_RE.test(b.paymentIntentId) || !isAmount(b.amountMinor)) refuse("KICKOFF_BINDING_INVALID");
  if (b.currency !== scope.currency || b.listingId !== scope.listingId) refuse("KICKOFF_NOT_SCOPED");
  if (scope.excludedIntentIds.includes(b.intentId) || scope.excludedListingIds.includes(b.listingId)) refuse("KICKOFF_EXCLUDED");
  const nb = isoMs(b.notBefore);
  if (nb === null || nb < isoMs(scope.cutoff) || nb < isoMs(constants.historicalFloor)) refuse("KICKOFF_HISTORIC");
  if (!HEX64.test(revision.sourceDigest) || !HEX64.test(revision.closureDigest) || revision.closureDigest !== constants.closureDigest) refuse("KICKOFF_REVISION_INVALID");
  const approvalRef = approvalRefFor(b.ref, b.authorizedVersion);
  const { planHash } = buildPlan(constants, { approvalRef, intentId: b.intentId, ref: b.ref, expectedVersion: b.authorizedVersion, notBefore: b.notBefore,
    paymentIntentId: b.paymentIntentId, amountMinor: b.amountMinor, currency: b.currency, sourceDigest: revision.sourceDigest });
  const inputs = freeze({ mode: "execute", approval_ref: approvalRef, intent_id: b.intentId, booking_ref: b.ref, expected_version: String(b.authorizedVersion),
    not_before: b.notBefore, payment_intent_id: b.paymentIntentId, amount_minor: String(b.amountMinor), currency: b.currency, expected_plan_hash: planHash,
    expected_source_digest: revision.sourceDigest, expected_closure_digest: revision.closureDigest });
  return freeze({ inputs, planHash, approvalRef });
}
