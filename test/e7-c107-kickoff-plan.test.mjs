// test/e7-c107-kickoff-plan.test.mjs — Stage E7 C107 (pure, no DB): the pinned plan copy + the workflow input grammar + the CLOSED consumer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as K from "../lib/checkout/pipeline-kickoff-plan.js";
import { KICKOFF_CONSTANTS, runPipelineKickoffOnce, classifyDispatch, kickoffAdmission } from "../lib/booking-db/pipeline-kickoff.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const C103 = { approvalRef: "ROOT-C103-PIPELINE-20261115", intentId: "1d6e770f-ba3d-40f7-92c1-ee01be7da532", ref: "MV-HYFP633M", expectedVersion: 4,
  notBefore: "2026-11-15T22:18:49.649Z", paymentIntentId: "pi_3UcCBg2B9LTneQgw1FnY0jHm", amountMinor: 14000, currency: "USD" };
const bound = (o = {}) => ({ intentId: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d", ref: "MV-ABCD1234", authorizedVersion: 4, paymentIntentId: "pi_3TestKickoff0001",
  amountMinor: 14000, currency: "USD", listingId: 606998, notBefore: "2026-11-16T00:00:01.234Z", ...o });

test("K1 known answer: the pinned plan copy reproduces ROOT's recorded C103 real plan hash 11c29542… (deployed ENABLE revision 9455bc9e, frame f09bcbbd) AND the C116 rebound frame b8716c54 answer 2ffa60ba… (real 9455bc9e runner bytes)", () => {
  // the HISTORICAL known answer still binds the copy: the deployed 9455bc9e revision's C103 plan at its own frame f09bcbbd
  assert.equal(K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...C103, sourceDigest: "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999" }).planHash, "11c29542491236af50ce8e89f28983c425944a3d0ee54ce642cccd1af754ca1b");
  // C116: the same inputs at the rebound ENABLE frame b8716c54 (known answer computed by the REAL 9455bc9e runner bytes a5b9ebca, not by this copy)
  const { planHash, plan } = K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...C103, sourceDigest: K.PINNED_REVISION.sourceDigest });
  assert.equal(planHash, "2ffa60ba5502d4ab2d9daa558caa2693059748858aeef6b37a40c744b0e1a0c0");
  assert.equal(plan.executeEnabled, true); assert.equal(plan.sourceDigest, "b8716c54854cca61490f9c35ce1e0aee76a2abb2e2b0ca8c27239ad507247558");
  assert.deepEqual(K.PINNED_REVISION, { wrapperCommit: "9455bc9ee15370b5321b7a04a96e893e9e80080b", wrapperTree: "f5eac3c1e31d0a9b90f841eac519a025dd6a444b",
    runnerPath: "scripts/e7-hosted-pipeline.mjs", runnerSha256: "a5b9ebca0c4b071f75d318357a8849070d9e2710b4ff652df8fa0ad4dc0cf7e7",
    workflowPath: ".github/workflows/e7-hosted-pipeline.yml", workflowFile: "e7-hosted-pipeline.yml",
    workflowSha256: "3feeed1588c091843c560815840ce98bd6d0fa335dc2acde37b3a42d81d3efbb",
    sourceDigest: "b8716c54854cca61490f9c35ce1e0aee76a2abb2e2b0ca8c27239ad507247558",
    closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273" });
});

test("K2 byte parity with the pinned revision (when its blobs are in the local object store): runner / workflow SHA-256, the CONSTANTS fields buildPlan reads, buildPlan on a vector set, the workflow input names", async (t) => {
  const show = (p) => spawnSync("git", ["cat-file", "-p", `${K.PINNED_REVISION.wrapperCommit}:${p}`], { cwd: ROOT, maxBuffer: 8 << 20 });
  const r = show(K.PINNED_REVISION.runnerPath); const w = show(K.PINNED_REVISION.workflowPath);
  if (r.status !== 0 || w.status !== 0) { t.skip("pinned revision not in the local object store (K1 known answer still binds parity)"); return; }
  assert.equal(sha(r.stdout), K.PINNED_REVISION.runnerSha256); assert.equal(sha(w.stdout), K.PINNED_REVISION.workflowSha256);
  const dir = mkdtempSync(join(tmpdir(), "c107-pin-")); writeFileSync(join(dir, "r.mjs"), r.stdout);
  const R = await import(pathToFileURL(join(dir, "r.mjs")).href);
  for (const k of Object.keys(K.PINNED_PLAN_CONSTANTS)) assert.deepEqual(R.CONSTANTS[k], K.PINNED_PLAN_CONSTANTS[k], k);
  for (const v of [{ ...C103 }, { ...C103, amountMinor: 1 }, { ...C103, amountMinor: 99999999, expectedVersion: 1000000 }, { ...C103, notBefore: "2026-11-16T00:00:00Z" },
    { ...C103, approvalRef: K.approvalRefFor("MV-ABCD1234", 7), ref: "MV-ABCD1234", intentId: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d" }]) {
    const a = R.buildPlan(R.CONSTANTS, { ...v, sourceDigest: K.PINNED_REVISION.sourceDigest }); const b = K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...v, sourceDigest: K.PINNED_REVISION.sourceDigest });
    assert.equal(b.planHash, a.planHash); assert.equal(K.canonical(b.plan), R.canonical(a.plan));
  }
  assert.deepEqual([...String(w.stdout).matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), [...K.WORKFLOW_INPUT_KEYS]);
});

test("K3 kickoffDispatch: the EXACT 12-input grammar (all strings, declared order) from server facts; plan hash = the pinned builder's; approval label derived, never client-chosen", () => {
  const d = K.kickoffDispatch(bound());
  assert.deepEqual(Object.keys(d.inputs), [...K.WORKFLOW_INPUT_KEYS]);
  assert.ok(Object.values(d.inputs).every((v) => typeof v === "string"));
  assert.deepEqual(d.inputs, { mode: "execute", approval_ref: "E7-KICKOFF-MV-ABCD1234-v4", intent_id: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d", booking_ref: "MV-ABCD1234",
    expected_version: "4", not_before: "2026-11-16T00:00:01.234Z", payment_intent_id: "pi_3TestKickoff0001", amount_minor: "14000", currency: "USD",
    expected_plan_hash: d.planHash, expected_source_digest: K.PINNED_REVISION.sourceDigest, expected_closure_digest: K.PINNED_REVISION.closureDigest });
  const again = K.buildPlan(K.PINNED_PLAN_CONSTANTS, { approvalRef: "E7-KICKOFF-MV-ABCD1234-v4", intentId: d.inputs.intent_id, ref: "MV-ABCD1234", expectedVersion: 4,
    notBefore: d.inputs.not_before, paymentIntentId: "pi_3TestKickoff0001", amountMinor: 14000, currency: "USD", sourceDigest: K.PINNED_REVISION.sourceDigest });
  assert.equal(d.planHash, again.planHash); assert.ok(Object.isFrozen(d.inputs));
});

test("K4 scope refusals before any plan: every known historical target (incl. C103 1d6e770f + C95 669da884), pre-cutoff (< 22:58:01Z), non-606998 / migrated / pilot listing, non-USD, malformed bindings", () => {
  const no = (o, code) => assert.throws(() => K.kickoffDispatch(bound(o)), (e) => e instanceof K.KickoffPlanRefusal && e.code === code, JSON.stringify(o));
  for (const id of K.KICKOFF_SCOPE.excludedIntentIds) no({ intentId: id }, "KICKOFF_EXCLUDED");
  assert.ok(K.KICKOFF_SCOPE.excludedIntentIds.includes("1d6e770f-ba3d-40f7-92c1-ee01be7da532") && K.KICKOFF_SCOPE.excludedIntentIds.includes("669da884-02e8-4105-8825-f908e5d22ae9"));
  no({ notBefore: "2026-11-15T22:58:00.999Z" }, "KICKOFF_HISTORIC"); K.kickoffDispatch(bound({ notBefore: "2026-11-15T22:58:01.000Z" }));
  for (const l of [603564, 603566, 628346, 628400, 1]) no({ listingId: l }, "KICKOFF_NOT_SCOPED");
  no({ currency: "MXN" }, "KICKOFF_NOT_SCOPED");
  for (const o of [{ intentId: "x" }, { ref: "mv-1" }, { authorizedVersion: 0 }, { paymentIntentId: "ch_1" }, { amountMinor: 0 }, { amountMinor: 100000000 }]) no(o, "KICKOFF_BINDING_INVALID");
  no({ notBefore: "2026-11-16" }, "KICKOFF_HISTORIC");
});

test("K5 SHIPPED CLOSED: dispatchEnabled false → refused BEFORE any read; an open constants object without an injected dispatcher refuses too; no env / network / credential surface in the new modules", async () => {
  assert.equal(KICKOFF_CONSTANTS.dispatchEnabled, false); assert.equal(KICKOFF_CONSTANTS.ref, "main"); assert.equal(KICKOFF_CONSTANTS.workflow, "e7-hosted-pipeline.yml");
  let reads = 0; const pool = { query: async () => { reads += 1; return { rows: [] }; } }; let sent = 0; const dispatch = async () => { sent += 1; return { accepted: true }; };
  assert.equal((await runPipelineKickoffOnce(pool, { workerId: "kw-1", dispatch })).code, "KICKOFF_CLOSED");
  assert.equal((await runPipelineKickoffOnce(pool, { workerId: "kw-1", constants: { ...KICKOFF_CONSTANTS, dispatchEnabled: true } })).code, "DISPATCH_ABSENT");
  assert.deepEqual([reads, sent], [0, 0]);
  for (const f of ["lib/booking-db/pipeline-kickoff.js", "lib/checkout/pipeline-kickoff-plan.js", "db/migrations/0024_pipeline_kickoff_requests.up.sql"]) {
    const s = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(s, /process\.env|fetch\(|https?:\/\/|api\.github|GITHUB_TOKEN|Authorization:|Bearer |octokit|node:https|node:http\b/, f);
  }
});

test("K6 dispatch classification: only {accepted:true} and {notSent:true, code} are definite; everything else (extra keys, strings, null, HTTP-ish objects) is UNKNOWN", () => {
  assert.deepEqual(classifyDispatch({ accepted: true }), { outcome: "dispatch_accepted", code: "HANDOFF_ACCEPTED" });
  assert.deepEqual(classifyDispatch({ notSent: true, code: "GATE_CLOSED" }), { outcome: "dispatch_refused", code: "NOT_SENT:GATE_CLOSED" });
  for (const v of [undefined, null, "ok", { accepted: "true" }, { accepted: true, status: 204 }, { status: 204 }, { notSent: true }, { notSent: true, code: "bad code" }, []]) {
    assert.equal(classifyDispatch(v).outcome, "dispatch_unknown", JSON.stringify(v));
  }
  assert.equal(kickoffAdmission({ request: null }), "NO_REQUEST");
});
