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

test("K1 known answers: the pinned plan copy reproduces ROOT's recorded C103 real plan hash 11c29542… (deployed ENABLE revision 9455bc9e, frame f09bcbbd), the C116 frame 880db5b3 answer 61ef5cef… (real 9455bc9e runner bytes) AND the C119 S4 frame 5294b6b4 answer f4572091… (computed by the REAL S4 ENABLE runner bytes — re-derived executably in K2)", () => {
  assert.equal(K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...C103, sourceDigest: "f09bcbbdfac88ca8dfd212a386d2af03698f9b710a49189b0ac9262531510999" }).planHash, "11c29542491236af50ce8e89f28983c425944a3d0ee54ce642cccd1af754ca1b");
  assert.equal(K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...C103, sourceDigest: "880db5b33024edbf0879fbaf5a3826e3622db12fd1808e8c2047238da507fe1b" }).planHash, "61ef5cef9aaf5f8aa1f497debc0bb6bd15646a5c06234b9d386afe80aa317c60");
  const { planHash, plan } = K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...C103, sourceDigest: K.PINNED_REVISION.sourceDigest });
  assert.equal(planHash, "f45720919816bbe60305250aa40c7fc83ab30bb0818c001674d64bca752e6b59");
  assert.equal(plan.executeEnabled, true); assert.equal(plan.sourceDigest, "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5");
  assert.deepEqual(K.PINNED_REVISION, {
    closedSourceCommit: "8c8c2d58bf431071ab6fa99c338984380a5b40cc",
    closedSourceDigest: "ca63c1d7db20a24aacd498e74f0bf2e9a229bfc31dc68ee75e59a5b4393ad8f7",
    enableDeltaPath: "test/fixtures/e7-c102-pipeline-enable-delta.json", enableDeltaSha256: "6c5fbd10d994e6c64b093c00734fbbaff7367ae96ef2fc999c1ff561280f6f0b",
    runnerFiles: ["scripts/e7-hosted-pipeline.mjs", "test/e7-hosted-pipeline.test.mjs", "test/e7-hosted-pipeline-workflow.test.mjs", ".github/workflows/e7-hosted-pipeline.yml"],
    sourcePrefix: "e7-hosted-pipeline-v1\n",
    runnerPath: "scripts/e7-hosted-pipeline.mjs", runnerSha256: "d4a593e973c20f0475bd111d6b2392d6656733368206319f2e79b5007459f673",
    workflowPath: ".github/workflows/e7-hosted-pipeline.yml", workflowFile: "e7-hosted-pipeline.yml",
    workflowSha256: "17208b78ccb35e3e80cd78edbc5d6e4a9f0db00712fad7a332e60f79ae495db4",
    sourceDigest: "5294b6b467839e1dd825e56063abc1ad1267eafdfb2973f2c2129e9b1f29c3f5",
    closureDigest: "f7d7cad646eaed2fb37a63e031157732ee6e2a44824f9d935d6b9104e08f7273" });
  assert.ok(!("wrapperCommit" in K.PINNED_REVISION) && !("wrapperTree" in K.PINNED_REVISION), "the historic 9455bc9e commit is NOT claimed to identify the S4 ENABLE bytes");
});

/** C119 S4 K2: the objects of PINNED_REVISION.closedSourceCommit come from E7_K2_WRAPPER_DIR (a checkout of that commit; the focused CI provides
 *  it and sets E7_K2_REQUIRED=1 so a missing object FAILS) or from this repository's own object store. */
function k2Show(t) {
  const dirs = [process.env.E7_K2_WRAPPER_DIR, ROOT].filter(Boolean);
  for (const d of dirs) {
    const head = spawnSync("git", ["cat-file", "-e", `${K.PINNED_REVISION.closedSourceCommit}^{commit}`], { cwd: d });
    if (head.status === 0) return (p) => { const r = spawnSync("git", ["cat-file", "-p", `${K.PINNED_REVISION.closedSourceCommit}:${p}`], { cwd: d, maxBuffer: 8 << 20 }); assert.equal(r.status, 0, p); return r.stdout; };
  }
  if (process.env.E7_K2_REQUIRED === "1") assert.fail("E7_K2_REQUIRED=1: the pinned closed source commit is not in any object store");
  t.skip("pinned closed source commit not in the local object store (the focused CI makes it REQUIRED)"); return null;
}
const k2Frame = (files, bytes, prefix) => { const h = createHash("sha256"); h.update(prefix); for (const f of files) { const b = bytes[f]; h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); } return h.digest("hex"); };

test("K2 C119 S4 EXECUTABLE end-to-end parity with the reviewed ENABLE artifact: CLOSED bytes at closedSourceCommit frame to closedSourceDigest; the delta (sha-pinned, from the SAME commit) applied forward reproduces runnerSha256 / workflowSha256 / sourceDigest (and back to closed); the REAL ENABLE runner imported from those bytes has the CONSTANTS fields buildPlan reads, the same buildPlan on a vector set, the workflow input names, and ACCEPTS the exact kickoff-generated binding (its own P5 check) while refusing a one-field change", async (t) => {
  const show = k2Show(t); if (!show) return;
  const R0 = K.PINNED_REVISION; const files = R0.runnerFiles;
  const deltaBytes = show(R0.enableDeltaPath); assert.equal(sha(deltaBytes), R0.enableDeltaSha256);
  const delta = JSON.parse(deltaBytes.toString("utf8"));
  const closed = Object.fromEntries(files.map((f) => [f, show(f)]));
  assert.equal(k2Frame(files, closed, R0.sourcePrefix), R0.closedSourceDigest); assert.equal(delta.closedFrame, R0.closedSourceDigest); assert.equal(delta.enableFrame, R0.sourceDigest);
  const text = Object.fromEntries(files.map((f) => [f, closed[f].toString("utf8")]));
  for (const o of delta.ops) { assert.equal(text[o.file].split(o.closed).length, 2, `op single occurrence in ${o.file}`); text[o.file] = text[o.file].replace(o.closed, () => o.enable); }
  const enable = Object.fromEntries(files.map((f) => [f, Buffer.from(text[f], "utf8")]));
  assert.equal(k2Frame(files, enable, R0.sourcePrefix), R0.sourceDigest);
  assert.equal(sha(enable[R0.runnerPath]), R0.runnerSha256); assert.equal(sha(enable[R0.workflowPath]), R0.workflowSha256);
  const back = { ...text }; for (const o of [...delta.ops].reverse()) { assert.equal(back[o.file].split(o.enable).length, 2); back[o.file] = back[o.file].replace(o.enable, () => o.closed); }
  assert.equal(k2Frame(files, Object.fromEntries(files.map((f) => [f, Buffer.from(back[f], "utf8")])), R0.sourcePrefix), R0.closedSourceDigest, "reverse delta restores the closed bytes");
  const dir = mkdtempSync(join(tmpdir(), "c119-s4-k2-")); writeFileSync(join(dir, "r.mjs"), enable[R0.runnerPath]);
  const R = await import(pathToFileURL(join(dir, "r.mjs")).href);
  assert.equal(R.CONSTANTS.executeEnabled, true, "the ENABLE artifact is opened");
  for (const k of Object.keys(K.PINNED_PLAN_CONSTANTS)) assert.deepEqual(R.CONSTANTS[k], K.PINNED_PLAN_CONSTANTS[k], k);
  for (const v of [{ ...C103 }, { ...C103, amountMinor: 1 }, { ...C103, amountMinor: 99999999, expectedVersion: 1000000 }, { ...C103, notBefore: "2026-11-16T00:00:00Z" },
    { ...C103, approvalRef: K.approvalRefFor("MV-ABCD1234", 7), ref: "MV-ABCD1234", intentId: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d" }]) {
    const a = R.buildPlan(R.CONSTANTS, { ...v, sourceDigest: R0.sourceDigest }); const b = K.buildPlan(K.PINNED_PLAN_CONSTANTS, { ...v, sourceDigest: R0.sourceDigest });
    assert.equal(b.planHash, a.planHash); assert.equal(K.canonical(b.plan), R.canonical(a.plan));
  }
  assert.deepEqual([...text[R0.workflowPath].matchAll(/^      ([a-z_]+):\n        description/gm)].map((m) => m[1]), [...K.WORKFLOW_INPUT_KEYS]);
  // end to end: the inputs THIS tooling dispatches are exactly the binding the ENABLE runner's P5 accepts (and a one-field change is refused)
  const d = K.kickoffDispatch(bound());
  const plan = R.buildPlan(R.CONSTANTS, { approvalRef: d.inputs.approval_ref, intentId: d.inputs.intent_id, ref: d.inputs.booking_ref, expectedVersion: Number(d.inputs.expected_version),
    notBefore: d.inputs.not_before, paymentIntentId: d.inputs.payment_intent_id, amountMinor: Number(d.inputs.amount_minor), currency: d.inputs.currency, sourceDigest: d.inputs.expected_source_digest });
  assert.equal(plan.planHash, d.planHash);
  const { mode: _m, ...rest } = d.inputs; assert.deepEqual(Object.keys(d.inputs), [...R.REQUEST_INPUT_KEYS]); assert.equal(_m, "execute"); assert.ok(rest);
  const binding = { planHash: d.planHash, inputs: { ...d.inputs } };
  assert.equal(R.requestBindingInvalid(binding, plan.plan, plan.planHash), null);
  assert.equal(R.requestBindingRefusal([{ intent_id: d.inputs.intent_id, state: "dispatch_accepted", plan_hash: d.planHash, dispatch_inputs: { ...d.inputs } }], binding), null);
  assert.equal(R.requestBindingRefusal([{ intent_id: d.inputs.intent_id, state: "dispatch_accepted", plan_hash: d.planHash, dispatch_inputs: { ...d.inputs, amount_minor: "14001" } }], binding), "REQUEST_INPUTS_MISMATCH");
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
