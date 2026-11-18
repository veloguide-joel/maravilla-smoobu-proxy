// test/e7-c119-s4-admission.test.mjs — C119 S4 (DRAFT, CLOSED): cross-runner ADMISSION evidence, deliberately OUTSIDE every runtime source frame
// (like test/e7-cross-runner-regression.test.mjs): it reads the five arm-gated jobs of three workflows and the tooling checkouts, so keeping it out of
// every frame keeps the cascade acyclic (pipeline → tooling → downstream frames). Nothing here sets an arm, a variable, an environment or a secret.
//
//   F1 (static, always): the P3 fresh-admission step is BYTE-IDENTICAL in all five moved jobs (pipeline execute, kickoff detect / execute,
//      confirmation detect / execute), sits right after the pre-secret re-check and BEFORE verify / dependency install / any secret step, carries only
//      the built-in token + this run's commit, and every job using the isolated environment e7-test-auto is arm-gated; e7-readonly-probe keeps
//      exactly the other 17 job references.
//   F2 (executed, always): the P3 block itself run with bash against a STUB curl (no network): the delayed path — main moved while the run waited
//      in the queue / for approval — is REFUSED (exit 3) before the next step; every malformed / failed reply refuses; the token never reaches argv
//      or output. Point-in-time only: a move AFTER this step is not seen by the run (stated, not hidden).
//   F3 (opt-in E7_S4_DB_TESTS=1 + PG_BIN + both tooling dirs): the FULL CHAIN on disposable PostgreSQL at schema 28 — a REAL authorization creates
//      the 0024 request → the REAL kickoff consumer (C119 S4 tooling) claims it with the REAL claim function (0028 literal) as the runtime role →
//      the EXACT dispatched inputs → the pipeline core (P5 reads the claim under RLS, real 71c3dcf8 coordinator + workers, FAKE providers) →
//      confirmed + ONE pristine notify. A hand-built dispatch without a claim and a re-run are refused with zero provider sends.
//   F4 (opt-in, the tooling dir present): main-side executable parity — the REAL ENABLE pipeline bytes of THIS checkout (C102 delta applied) build
//      the same plan as the tooling copy for kickoff-generated inputs and their P5 accepts exactly that binding.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { request: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => assert.deepEqual(GUARD, { request: 0, fetch: 0 }, "no real network primitive touched"));

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const SELF = "test/e7-c119-s4-admission.test.mjs";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const WF = { pipeline: ".github/workflows/e7-hosted-pipeline.yml", kickoff: ".github/workflows/e7-hosted-kickoff.yml", confirmation: ".github/workflows/e7-hosted-booking-confirmation.yml" };
const Y = Object.fromEntries(Object.entries(WF).map(([k, f]) => [k, readFileSync(join(ROOT, f), "utf8")]));
const jobOf = (yml, name) => { const a = yml.indexOf(`\n  ${name}:\n`); assert.ok(a >= 0, name); const m = /\n  [a-z-]+:\n/g; m.lastIndex = a + 3; const n = m.exec(yml); return yml.slice(a, n ? n.index : yml.length); };
const stepNames = (job) => [...job.matchAll(/\n      - name: ([^\n]+)/g)].map((x) => x[1]);
const stepOf = (job, prefix) => { const a = job.indexOf(`\n      - name: ${prefix}`); assert.ok(a >= 0, prefix); const b = job.indexOf("\n      - name: ", a + 10); return job.slice(a + 1, b < 0 ? job.length : b + 1); };
const runOf = (step) => { const m = step.match(/\n        run: \|\n((?:          .*\n)+)/); assert.ok(m, "run block"); return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n"); };
const MOVED = [["pipeline", "execute"], ["kickoff", "detect"], ["kickoff", "execute"], ["confirmation", "detect"], ["confirmation", "execute"]];
const P3 = "Fresh admission (C119 S4 P3;";

test("F1 static: the P3 fresh-admission step is BYTE-IDENTICAL in the five moved jobs, placed right after the pre-secret re-check and before verify / npm / any secret; only the built-in token + this run's commit; every e7-test-auto job is arm-gated; e7-readonly-probe keeps exactly the other 16 job references (C120: + the sink-probe send job moved, checked explicitly); this file is in no runtime frame", async () => {
  const blocks = MOVED.map(([w, j]) => { const job = jobOf(Y[w], j); return { w, j, job, step: stepOf(job, P3) }; });
  for (const b of blocks) assert.equal(b.step, blocks[0].step, `${b.w}.${b.j}: P3 byte-identical`);
  const st = blocks[0].step;
  assert.match(st, /^      - name: Fresh admission \(C119 S4 P3; [^\n]+\n        env:\n          FRESH_SHA: \$\{\{ github\.sha \}\}\n          FRESH_TOKEN: \$\{\{ github\.token \}\}\n        run: \|\n/);
  assert.doesNotMatch(st, /secrets\.|E7_|vars\.|\$\{\{ (?!github\.sha \}\}|github\.token \}\})/, "no secret / runner key / variable / other expression");
  const run = runOf(st);
  assert.doesNotMatch(run, /\$\{\{/, "no expression inside the run block");
  assert.match(run, /https:\/\/api\.github\.com\/repos\/veloguide-joel\/maravilla-smoobu-proxy\/git\/ref\/heads\/main\)/);
  assert.match(run, /--proto '=https' --max-redirs 0 --max-time 15 --max-filesize 8192 -H @-/, "bounded, https-only, no redirect; the token via stdin (never argv)");
  for (const b of blocks) {
    const names = stepNames(b.job); const i = names.findIndex((n) => n.startsWith(P3)); const rc = names.findIndex((n) => n.startsWith("Re-check bindings BEFORE"));
    assert.ok(rc >= 0 && i === rc + 1, `${b.w}.${b.j}: P3 right after the pre-secret re-check`);
    for (const later of names.slice(0, i)) assert.ok(!/Install the pinned|Fetch the public|ONE |Verify/.test(later), `${b.w}.${b.j}: nothing secret-bearing / verify before P3 (${later})`);
    const before = b.job.slice(0, b.job.indexOf(`\n      - name: ${P3}`));
    assert.doesNotMatch(before, /secrets\./, `${b.w}.${b.j}: no secret before P3`);
    assert.match(b.job, /\n    environment: e7-test-auto\n/, `${b.w}.${b.j}: the isolated TEST environment`);
    assert.match(b.job.split("\n    runs-on:")[0], /needs\.arm\.outputs\.armed == 'true'/, `${b.w}.${b.j}: arm-gated (skipped while unarmed → no environment is auto-created)`);
  }
  let probe = 0; let auto = 0;
  // C120 diagnostics: manual-only, main-only, reviewer-gated, ONE secret each, no arm, no runtime module
  const DIAG = { "e7-test-auto-db-connection-check.yml": "secrets.E7_DEV_BOOKING_DATABASE_URL", "e7-test-auto-hostaway-listing-check.yml": "secrets.E7_HOSTAWAY_TOKEN",
    "e7-test-auto-resend-key-check.yml": "secrets.E7_RESEND_TEST_KEY" };
  for (const f of readdirSync(join(ROOT, ".github/workflows"))) {
    const t = readFileSync(join(ROOT, ".github/workflows", f), "utf8");
    if (Object.hasOwn(DIAG, f)) {
      assert.match(t, /\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read\n/, "diagnostic: manual dispatch only, no inputs, read-only token");
      assert.deepEqual((t.match(/environment: e7-test-auto/g) || []).length, 1); assert.match(t, /\n    if: github\.ref == 'refs\/heads\/main'\n/);
      assert.deepEqual(t.match(/secrets\.[A-Z0-9_]+/g), [DIAG[f]], `diagnostic ${f}: its one secret only`);
      assert.doesNotMatch(t, /schedule:|vars\.|github\.token|actions: write|wrapper\/scripts|import\(/, "diagnostic: no schedule / arm / token / runtime module");
      continue;
    }
    // C120: the existing WRITE-capable SYNTHETIC Resend sink probe (NOT a read-only diagnostic): its ONE send job moved to e7-test-auto;
    // manual-only, main-only, needs its own preflight, ONE secret, no schedule / arm / token / variable; every other byte keeps its own W1–W7 tests
    if (f === "e7-resend-sink-probe.yml") {
      assert.match(t, /\non:\n  workflow_dispatch:\n    inputs:\n/, "sink probe: manual dispatch only"); assert.match(t, /\npermissions:\n  contents: read\n/);
      assert.deepEqual(t.match(/environment: [a-z0-9-]+/g), ["environment: e7-test-auto"], "sink probe: ONE environment, the isolated TEST one");
      assert.match(t, /\n  send:\n    needs: preflight\n    if: inputs\.mode == 'send' && github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-test-auto\n/);
      assert.deepEqual(t.match(/secrets\.[A-Z0-9_]+/g), ["secrets.E7_RESEND_TEST_KEY"], "sink probe: its one secret only");
      assert.doesNotMatch(t, /schedule:|vars\.|github\.token|actions: write|import\(/, "sink probe: no schedule / arm / token / variable");
      continue;
    }
    probe += (t.match(/\n    environment: e7-readonly-probe\n/g) || []).length; auto += (t.match(/environment: e7-test-auto/g) || []).length;
  }
  assert.deepEqual([probe, auto], [16, 5], "the 5 moved jobs only (+ the C120 sink-probe send job, checked above); every other e7-readonly-probe reference untouched");
  // outside every runtime frame: no runner frame / arm component lists or names this file
  const A = await import("../scripts/e7-test-arm.mjs"); const M = JSON.parse(readFileSync(join(ROOT, A.ARM_MANIFEST_PATH), "utf8"));
  const S = await import("../scripts/e7-hosted-status.mjs");
  for (const f of new Set([...M.components.flatMap((x) => x.files), ...S.CONSTANTS.runnerFiles])) { assert.notEqual(f, SELF);
    assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /(import\(|from |readFileSync\([^)]*)["'`][^"'`]*e7-c119-s4-admission/, `${f} never imports / reads this file`); }
});

// ---- F2: the P3 block EXECUTED against a stub curl (bash; no network) ---------------------------------------------------------------------
const SHA_A = "a".repeat(40); const SHA_B = "b".repeat(40); const TOKEN = ["ghs", "SYNTHETICfreshtoken0123456789abcdefghijklmn"].join("_");
function runP3(run, { mode, sha = SHA_A, token = TOKEN, body = null }) {
  const d = mkdtempSync(join(tmpdir(), "e7-s4-p3-"));
  try {
    const bin = join(d, "bin"); spawnSync("mkdir", ["-p", bin]);
    // the stub records argv + stdin and answers per STUB_MODE (curl --fail semantics: HTTP >= 400 → exit 22; timeout → exit 28)
    writeFileSync(join(bin, "curl"), `#!/bin/bash
printf '%s\\n' "$@" > "${d}/argv"; cat > "${d}/stdin"
case "$STUB_MODE" in
  ok) printf '%s' "$STUB_BODY" ;;
  http404) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
  http500) echo "curl: (22) The requested URL returned error: 500" >&2; exit 22 ;;
  timeout) echo "curl: (28) Operation timed out" >&2; exit 28 ;;
  *) exit 7 ;;
esac
`); chmodSync(join(bin, "curl"), 0o755);
    const ref = (s, o = {}) => JSON.stringify({ ref: "refs/heads/main", node_id: "REF_x", url: "https://api.github.com/x", object: { type: "commit", sha: s, url: "https://api.github.com/y" }, ...o });
    const r = spawnSync("bash", ["-c", run], { encoding: "utf8", env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, FRESH_SHA: sha, FRESH_TOKEN: token, STUB_MODE: mode,
      STUB_BODY: body === null ? ref(SHA_A) : typeof body === "function" ? body(ref) : body } });
    const argv = existsSync(join(d, "argv")) ? readFileSync(join(d, "argv"), "utf8") : null; const stdin = existsSync(join(d, "stdin")) ? readFileSync(join(d, "stdin"), "utf8") : null;
    return { status: r.status, out: `${r.stdout}${r.stderr}`, argv, stdin };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

test("F2 the P3 block EXECUTED (stub curl, no network) for EACH of the five jobs — the DELAYED path (main moved while queued / approval-held: pipeline run, kickoff dispatch, confirmation send) is REFUSED with exit 3 before the next step; unreadable / malformed replies refuse; the built-in token never reaches argv or output; a match passes and says it is point-in-time", () => {
  for (const [w, j] of MOVED) {
    const run = runOf(stepOf(jobOf(Y[w], j), P3)); const tag = `${w}.${j}`;
    const ok = runP3(run, { mode: "ok" });
    assert.deepEqual([ok.status, /fresh admission ok: live main == this run's commit \(point-in-time/.test(ok.out)], [0, true], `${tag}: ${ok.out}`);
    assert.ok(!ok.argv.includes(TOKEN) && !ok.out.includes(TOKEN), `${tag}: the token never in argv / output`);
    assert.equal(ok.stdin, `Authorization: Bearer ${TOKEN}\n`, `${tag}: the token only on stdin as the one header`);
    assert.deepEqual(ok.argv.trim().split("\n"), ["--silent", "--show-error", "--fail", "--proto", "=https", "--max-redirs", "0", "--max-time", "15", "--max-filesize", "8192", "-H", "@-",
      "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", "https://api.github.com/repos/veloguide-joel/maravilla-smoobu-proxy/git/ref/heads/main"], tag);
    // the DELAYED path: this run was dispatched at SHA_A; while it waited, a CLOSE commit moved main to SHA_B → refused before verify / any secret
    const moved = runP3(run, { mode: "ok", body: (ref) => ref(SHA_B) });
    assert.deepEqual([moved.status, /REFUSED: MAIN_MOVED/.test(moved.out)], [3, true], `${tag} delayed: ${moved.out}`);
    for (const [why, o] of [["404", { mode: "http404" }], ["500", { mode: "http500" }], ["timeout", { mode: "timeout" }], ["conn", { mode: "refused" }],
      ["not json", { mode: "ok", body: "<html>" }], ["wrong ref", { mode: "ok", body: (ref) => ref(SHA_A, { ref: "refs/heads/dev" }) }],
      ["tag object", { mode: "ok", body: (ref) => JSON.stringify({ ref: "refs/heads/main", object: { type: "tag", sha: SHA_A } }) }],
      ["upper sha", { mode: "ok", body: (ref) => ref(SHA_A.toUpperCase()) }], ["short sha", { mode: "ok", body: (ref) => ref(SHA_A.slice(1)) }],
      ["oversize", { mode: "ok", body: `${" ".repeat(9000)}{}` }], ["empty", { mode: "ok", body: "" }], ["no token", { mode: "ok", token: "" }],
      ["bad run sha", { mode: "ok", sha: "main" }]]) {
      const x = runP3(run, o);
      assert.deepEqual([x.status, /REFUSED: MAIN_UNREADABLE/.test(x.out)], [3, true], `${tag} ${why}: ${x.out}`);
      assert.ok(!x.out.includes(TOKEN), `${tag} ${why}: no token in output`);
    }
  }
});

// ---- F4: main-side executable parity with the tooling copy (needs the C119 S4 tooling checkout) ------------------------------------------
const TK = process.env.E7_KICKOFF_TOOLING_DIR ? realpathSync(process.env.E7_KICKOFF_TOOLING_DIR) : null;
test("F4 main-side parity: the REAL ENABLE pipeline bytes of THIS checkout (C102 delta applied) reproduce the tooling PINNED_REVISION hashes, build the SAME plan as the tooling copy for kickoff-generated inputs, and their P5 accepts exactly that binding (a one-field change refused)", { skip: TK ? false : "E7_KICKOFF_TOOLING_DIR not set" }, async () => {
  const Kp = await import(pathToFileURL(join(TK, "lib/checkout/pipeline-kickoff-plan.js")).href);
  const PR = Kp.PINNED_REVISION; const D = JSON.parse(readFileSync(join(ROOT, PR.enableDeltaPath), "utf8"));
  assert.equal(sha(readFileSync(join(ROOT, PR.enableDeltaPath))), PR.enableDeltaSha256, "the delta bytes of this checkout == the pinned delta");
  const text = Object.fromEntries(PR.runnerFiles.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  const frame = (t) => { const h = createHash("sha256"); h.update(PR.sourcePrefix); for (const f of PR.runnerFiles) { const b = Buffer.from(t[f], "utf8"); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); } return h.digest("hex"); };
  assert.equal(frame(text), PR.closedSourceDigest, "this checkout's CLOSED pipeline bytes == the pinned closed frame");
  for (const o of D.ops) { assert.equal(text[o.file].split(o.closed).length, 2); text[o.file] = text[o.file].replace(o.closed, () => o.enable); }
  assert.equal(frame(text), PR.sourceDigest); assert.equal(sha(Buffer.from(text[PR.runnerPath], "utf8")), PR.runnerSha256); assert.equal(sha(Buffer.from(text[PR.workflowPath], "utf8")), PR.workflowSha256);
  const d = mkdtempSync(join(tmpdir(), "e7-s4-en-")); writeFileSync(join(d, "r.mjs"), text[PR.runnerPath]);
  try {
    const R = await import(pathToFileURL(join(d, "r.mjs")).href);
    const x = Kp.kickoffDispatch({ intentId: "2b7c5a10-0f3e-4d1a-9c2b-7e5f4a3b2c1d", ref: "MV-ABCD1234", authorizedVersion: 4, paymentIntentId: "pi_3TestKickoff0001", amountMinor: 14000, currency: "USD", listingId: 606998, notBefore: "2026-11-16T00:00:01.234Z" });
    const p = R.buildPlan(R.CONSTANTS, { approvalRef: x.inputs.approval_ref, intentId: x.inputs.intent_id, ref: x.inputs.booking_ref, expectedVersion: Number(x.inputs.expected_version), notBefore: x.inputs.not_before,
      paymentIntentId: x.inputs.payment_intent_id, amountMinor: Number(x.inputs.amount_minor), currency: x.inputs.currency, sourceDigest: x.inputs.expected_source_digest });
    assert.equal(p.planHash, x.planHash);
    const b = { planHash: x.planHash, inputs: { ...x.inputs } };
    assert.equal(R.requestBindingInvalid(b, p.plan, p.planHash), null);
    assert.equal(R.requestBindingRefusal([{ intent_id: x.inputs.intent_id, state: "claimed", plan_hash: x.planHash, dispatch_inputs: { ...x.inputs } }], b), null);
    assert.equal(R.requestBindingRefusal([{ intent_id: x.inputs.intent_id, state: "claimed", plan_hash: x.planHash, dispatch_inputs: { ...x.inputs, booking_ref: "MV-ZZZZ9999" } }], b), "REQUEST_INPUTS_MISMATCH");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- F3: the FULL CHAIN on disposable PostgreSQL at schema 28 ---------------------------------------------------------------------------
if (process.env.E7_S4_DB_TESTS === "1") {
  const TP = realpathSync(process.env.E7_TOOLING_DIR);                         // the pipeline's pinned coordinator tooling (71c3dcf8)
  assert.ok(TK, "E7_KICKOFF_TOOLING_DIR (the C119 S4 tooling) is required");
  const tp = (p) => import(pathToFileURL(join(TP, p)).href); const tk = (p) => import(pathToFileURL(join(TK, p)).href);
  const E = await import("../scripts/e7-hosted-pipeline.mjs");
  const RECRUN = await import("../scripts/e7-hosted-recording.mjs");
  const [T, EA, HR, CP, RP, IS, LK, CO, R, O, F, SP, DP, PA] = await Promise.all([tp("scripts/e7-connected/http-transports.mjs"), tp("scripts/e7-connected/executor-adapters.mjs"),
    tp("lib/hostaway-reservations.js"), tp("lib/checkout/capture-proof.js"), tp("lib/checkout/recovery-plan.js"), tp("lib/checkout/intent-state.js"), tp("scripts/e7-connected/run-lock-precheck.mjs"),
    tp("lib/booking-db/test-pipeline-coordinator.js"), tp("lib/booking-db/repo.js"), tp("lib/booking-db/operations.js"), tp("test/db/fixtures.mjs"), tp("lib/checkout/server-pricer.js"),
    tp("lib/direct-policy.js"), tp("lib/public-api.js")]);
  const [{ startMigratedDatabase }, KC, Kp] = await Promise.all([tk("test/db/harness.mjs"), tk("lib/booking-db/pipeline-kickoff.js"), tk("lib/checkout/pipeline-kickoff-plan.js")]);
  const realTooling = { refundObservationRefusal: CO.refundObservationRefusal, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
    createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
    paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCapturedProof: RP.piCapturedProof,
    captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL, runTestPipelineCoordinator: CO.runTestPipelineCoordinator, loadIntent: R.loadIntent };
  assert.equal(typeof RECRUN.refundObservationRefusal, "function");
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const C = E.CONSTANTS; const OPENC = Object.freeze({ ...C, executeEnabled: true });                     // the ENABLE constants (the real ENABLE artifact has executeEnabled true)
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
  const LIST = 606998; const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN; const NIGHTLY = 140;
  const POLICY = DP.readDirectPolicyFromEnv({ VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" }).policy;
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const pricing = {
    get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } }; },
    post: async (path, body) => { const n = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * n, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * n, isIncludedInTotalPrice: 1 }] } } }; }
  };
  let lane = 0;
  /** LABELLED COPY (adapted) of the pipeline suite's authorizedBooking (itself the coordinator suite's): a fresh payment_authorized USD intent on 606998 */
  async function authorizedBooking() {
    lane += 1;
    const stay = { listingId: LIST, from: F.addDays("2027-06-01", 5 * lane), to: F.addDays("2027-06-01", 5 * lane + 2), guests: 2 };
    const base = Date.now() - 20 * MIN;
    const priced = await SP.priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: PA.todayInTimeZone(undefined, new Date(base)), now: base });
    assert.ok(priced.ok, priced.error);
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
    const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
    const op = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
    const sessionId = `cs_test_s4c${lane}`;
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
    F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
    const piId = `pi_test_s4c${String(lane).padStart(4, "0")}`;
    const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
      currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
    const i = await R.loadIntent(db.app, intent.id);
    return { id: intent.id, ref: i.ref, version: i.version, stay, piId, attemptId: pa, total: priced.price.finalTotalMinor, base, captureBefore };
  }
  /** fake provider world (success path) on the WIRE through the REAL adapters / transports */
  function world(bk) {
    const w = { calls: [], res: new Map(), charges: [], nextRes: 75000000 + lane * 10, nextCharge: 8900000 + lane * 10, captured: false, creates: 0, captures: 0, records: 0 };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    w.pi = () => ({ object: "payment_intent", id: bk.piId, livemode: false, status: w.captured ? "succeeded" : "requires_capture", capture_method: "manual", amount: bk.total,
      amount_received: w.captured ? bk.total : 0, amount_capturable: w.captured ? 0 : bk.total, currency: "usd", metadata: { mv_intent_id: bk.id, mv_payment_attempt_id: bk.attemptId },
      latest_charge: { object: "charge", id: `ch_test_s4c${lane}`, payment_intent: bk.piId, status: "succeeded", paid: true, captured: w.captured, amount: bk.total,
        amount_captured: w.captured ? bk.total : 0, amount_refunded: 0, refunded: false, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: bk.captureBefore / 1000 } } } });
    const full = (r) => ({ id: r.id, listingMapId: LIST, channelId: 2000, arrivalDate: bk.stay.from, departureDate: bk.stay.to, totalPrice: bk.total / 100, currency: "USD", status: "new",
      customFieldValues: [{ customFieldId: C.refFieldId, value: bk.ref }] });
    w.stripe = async (req) => { w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
      if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: C.accountId });
      if (req.method === "POST") { w.captures += 1; w.captured = true; } return reply(200, w.pi()); };
    w.hostaway = async (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`); const u = new URL(req.url);
      if (req.method === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return pricing.get(p.slice(3)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(u.pathname)) return pricing.get(u.pathname.slice(3), { query: Object.fromEntries(u.searchParams) }).then((x) => reply(x.status, x.json));
      if (req.method === "POST" && /priceDetails$/.test(p)) return pricing.post(p.slice(3), JSON.parse(req.body)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: u.searchParams.has("afterId") ? [] : [...w.res.values()].map(full) });
      if (req.method === "POST" && p === "/v1/reservations") { const r = { id: w.nextRes++ }; w.res.set(r.id, r); w.creates += 1; return reply(201, { status: "success", result: full(r) }); }
      if (req.method === "GET" && p.startsWith("/v1/guestPayments/charges?")) { const rid = u.searchParams.get("reservationIds"); const rows = w.charges.filter((x) => String(x.reservationId) === rid);
        return reply(200, { status: "success", result: rows, count: rows.length, limit: 500, offset: null }); }
      if (req.method === "POST" && /^\/v1\/guestPayments\/charges\/\d+$/.test(p)) { const body = JSON.parse(req.body);
        const ch = { id: w.nextCharge++, listingMapId: LIST, reservationId: Number(p.split("/").pop()), type: "charge", title: body.title, currency: "USD", paymentMethod: body.paymentMethod, amount: body.amount, status: "paid", paymentProvider: "offline" };
        w.charges.push(ch); w.records += 1; return reply(201, { status: "success", result: { ...ch } }); }
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p); if (req.method === "GET" && m) { const r = w.res.get(Number(m[1])); return r ? reply(200, { status: "success", result: full(r) }) : reply(404, { status: "fail" }); }
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const writes = (w) => w.calls.filter((x) => /^(S POST|H POST(?! \/v1\/listings))/.test(x));
  const reqRow = async (id) => (await db.app.query("SELECT state, plan_hash, dispatch_inputs, claim_worker FROM booking.pipeline_kickoff_requests WHERE intent_id = $1", [id])).rows;
  /** what runHosted hands the core: the plan from the dispatched input STRINGS (ENABLE constants) + the binding = exactly those strings */
  const fromInputs = (x, over = {}) => { const v = { ...x, ...over };
    const p = E.buildPlan(OPENC, { approvalRef: v.approval_ref, intentId: v.intent_id, ref: v.booking_ref, expectedVersion: Number(v.expected_version), notBefore: v.not_before,
      paymentIntentId: v.payment_intent_id, amountMinor: Number(v.amount_minor), currency: v.currency, sourceDigest: v.expected_source_digest });
    return { plan: p.plan, planHash: p.planHash, binding: Object.freeze({ planHash: p.planHash, inputs: Object.freeze({ ...v, expected_plan_hash: v.expected_plan_hash ?? p.planHash }) }) }; };
  const core = (bk, w, b) => E.runPipelineCore({ requestBinding: b.binding, plan: b.plan, pool: db.app, tooling: realTooling, exchanges: { stripe: w.stripe, hostaway: w.hostaway },
    credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, runId: "s4-chain-0001", clock: () => bk.base + 10 * SEC, recordingClock: Date.now });

  test("F3 FULL CHAIN (schema 28, REAL runtime role / RLS): authorization → 0024 request (requested) → REAL kickoff consumer claims with the REAL 0028 claim function and dispatches the EXACT pinned inputs → the pipeline core with EXACTLY those inputs (P5 BOUND at admission + before the invocation; real coordinator / workers; fake providers) → confirmed, 1 create / 1 capture / 1 record, ONE pristine booking_confirmed notify; a RE-RUN of the same inputs is refused with zero sends", async () => {
    const version = (await db.owner.query("SELECT max(version)::int AS v FROM booking_migrations.applied")).rows[0].v; assert.equal(version, 28);
    const bk = await authorizedBooking();
    assert.deepEqual((await reqRow(bk.id)).map((r) => r.state), ["requested"], "the authorization trigger recorded ONE request");
    const calls = []; const dispatch = async (call) => { calls.push(JSON.parse(JSON.stringify(call))); return { accepted: true }; };
    const k = await KC.runPipelineKickoffOnce(db.app, { workerId: "s4-chain", dispatch, constants: Object.freeze({ ...KC.KICKOFF_CONSTANTS, dispatchEnabled: true }), intentId: bk.id });
    assert.deepEqual([k.code, k.outcome, calls.length], ["HANDOFF_ACCEPTED", "dispatch_accepted", 1], JSON.stringify(k));
    const inputs = calls[0].inputs; assert.deepEqual(Object.keys(inputs), [...E.REQUEST_INPUT_KEYS]); assert.equal(inputs.expected_source_digest, Kp.PINNED_REVISION.sourceDigest);
    const row = (await reqRow(bk.id))[0]; assert.deepEqual([row.state, row.dispatch_inputs], ["dispatch_accepted", inputs], "the frozen claim == the dispatched inputs");
    const b = fromInputs(inputs); assert.equal(b.planHash, inputs.expected_plan_hash, "the pipeline plan from the dispatched strings == the claimed plan hash (parity)");
    assert.equal(E.requestBindingInvalid(b.binding, b.plan, b.planHash), null);
    const w = world(bk); const r = await core(bk, w, b);
    assert.deepEqual([r.outcome, r.verifiedCompletion, r.requestBinding, r.sends], ["CONFIRMED_VERIFIED", true, ["ADMISSION:BOUND", "FIRST:BOUND"], { create: 1, capture: 1, record: 1 }], JSON.stringify(r).slice(0, 400));
    assert.deepEqual([w.creates, w.captures, w.records], [1, 1, 1]);
    const n = (await db.owner.query("SELECT state, attempts, (dispatched_at IS NOT NULL) AS d, payload ->> 'template' AS t FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [bk.id])).rows;
    assert.equal(n.length, 1, "ONE notify op"); assert.deepEqual([n[0].attempts, n[0].d], [0, false], "pristine (undispatched)");
    // a RE-RUN (the same dispatched inputs again, e.g. a workflow re-run): refused read-only (version moved past the claimed authorization) — zero sends
    const w2 = world(bk); const again = await core(bk, w2, b);
    assert.equal(again.outcome, "STOP"); assert.match(again.code, /^ADMISSION_REFUSED:/); assert.equal(writes(w2).length, 0);
  });

  test("F3b direct / hand-built dispatch (no kickoff claim: the request is still `requested`) and a tampered dispatch of a CLAIMED request (one field changed) → STOP ADMISSION_REFUSED at P5 BEFORE any provider exchange; intent / version / ops unchanged", async () => {
    const bk = await authorizedBooking();
    const hand = { mode: "execute", approval_ref: `E7-KICKOFF-${bk.ref}-v${bk.version}`, intent_id: bk.id, booking_ref: bk.ref, expected_version: String(bk.version),
      not_before: new Date(bk.base - MIN).toISOString(), payment_intent_id: bk.piId, amount_minor: String(bk.total), currency: "USD", expected_source_digest: Kp.PINNED_REVISION.sourceDigest,
      expected_closure_digest: C.closureDigest };
    const b0 = fromInputs({ ...hand, expected_plan_hash: undefined }); const b = { ...b0, binding: Object.freeze({ planHash: b0.planHash, inputs: Object.freeze({ ...hand, expected_plan_hash: b0.planHash }) }) };
    const s0 = (await db.owner.query("SELECT state, version FROM booking.intents WHERE id = $1", [bk.id])).rows[0];
    const w = world(bk); const r = await core(bk, w, b);
    assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, w.calls.length], ["STOP", "ADMISSION_REFUSED:REQUEST_NOT_DISPATCHED:REQUESTED", 0, 0], JSON.stringify(r).slice(0, 300));
    assert.deepEqual((await db.owner.query("SELECT state, version FROM booking.intents WHERE id = $1", [bk.id])).rows[0], s0);
    // now a REAL claim, then a dispatch that differs in ONE field from the claim (e.g. a hand-edited approval label) → mismatch, zero calls
    const calls = []; const k = await KC.runPipelineKickoffOnce(db.app, { workerId: "s4-chain-b", dispatch: async (c) => { calls.push(c); return { accepted: true }; },
      constants: Object.freeze({ ...KC.KICKOFF_CONSTANTS, dispatchEnabled: true }), intentId: bk.id });
    assert.equal(k.code, "HANDOFF_ACCEPTED");
    const tampered = fromInputs({ ...calls[0].inputs, not_before: new Date(Date.parse(calls[0].inputs.not_before) - 1).toISOString(), expected_plan_hash: undefined });
    const w2 = world(bk); const r2 = await core(bk, w2, tampered);
    assert.deepEqual([r2.outcome, r2.coordinatorInvocations, w2.calls.length], ["STOP", 0, 0]); assert.match(r2.code, /^ADMISSION_REFUSED:REQUEST_(PLAN_HASH|INPUTS)_MISMATCH$/);
  });
}
