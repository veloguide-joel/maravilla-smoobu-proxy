// test/e7-hosted-pipeline.test.mjs — C90 hosted TEST pipeline runner (scripts/e7-hosted-pipeline.mjs). LABELS
//   * REAL: the runner; from the PINNED tooling (E7_TOOLING_DIR, default ../../tooling = workflow layout): env preflight, the v3 PI proof, the
//     captured proof, captureKey, the coordinator's refundObservationRefusal, the transports / executor adapters / Hostaway normalizers.
//   * FAKE (always): DB (tagged SELECT fake), a SCRIPTED coordinator for the outcome-mapping cases, provider exchanges, credentials. Every real
//     network primitive is a throwing guard. Mock replies are NOT provider proof.
//   * OPT-IN INTEGRATION (E7_HPL_DB_TESTS=1 + PG_BIN): the REAL merged coordinator + reservation / capture / recording workers + repo +
//     operations + executor adapters + transports on a DISPOSABLE PostgreSQL (tooling test/db/harness.mjs), FAKE exchanges only. The hosted
//     preflight child never sets E7_HPL_DB_TESTS (childEnv allowlist), so preflight runs the fake suites only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const GUARD = { request: 0, Agent: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.Agent += 1; throw new Error("network refused"); } };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
const E = await import("../scripts/e7-hosted-pipeline.mjs");
const RESRUN = await import("../scripts/e7-hosted-reservation.mjs");
const RECRUN = await import("../scripts/e7-hosted-recording.mjs");
// NOTE: the coordinator (→ workers → lib/booking-db/pool.js → pg) is imported ONLY in the opt-in PG suite: the hosted preflight has no dependency install.
const [T, EA, HR, C1, CP, RP, IS, LK] = await Promise.all([tool("scripts/e7-connected/http-transports.mjs"), tool("scripts/e7-connected/executor-adapters.mjs"),
  tool("lib/hostaway-reservations.js"), tool("scripts/e7-connected/probe-env-preflight.mjs"), tool("lib/checkout/capture-proof.js"), tool("lib/checkout/recovery-plan.js"),
  tool("lib/checkout/intent-state.js"), tool("scripts/e7-connected/run-lock-precheck.mjs")]);
after(() => { assert.deepEqual(GUARD, { request: 0, Agent: 0, fetch: 0 }, "no real network primitive was touched"); });

const C = E.CONSTANTS;
const PIN = "71c3dcf83c6b78a2cb0c6a7e829b5ecb23d37af5";
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
// fake suites: the main C16 refundObservationRefusal (the coordinator ports it "verbatim in semantics"; P0 asserts the two agree on the real coordinator)
const pureTooling = { refundObservationRefusal: RECRUN.refundObservationRefusal, createPhaseExecutors: EA.createPhaseExecutors, createStripeSend: T.createE7StripeTestSend,
  createHostawaySend: T.createE7HostawaySend, validateAdapterConfig: HR.validateAdapterConfig, unwrapEnvelope: HR.unwrapEnvelope, normalizeReservation: HR.normalizeReservation,
  paymentIntentProofObservationV3: CP.paymentIntentProofObservationV3, stillAuthorizedV3Refusal: CP.stillAuthorizedV3Refusal, piCapturedProof: RP.piCapturedProof,
  captureKey: IS.captureKey, LOCK_KEY: LK.LOCK_KEY, LOCK_PRECHECK_SQL: LK.LOCK_PRECHECK_SQL };

// ---------------------------------------------------------------------------------------------------------------------------------
test("H1 pins: tooling 71c3dcf8 (contains the accepted C88 coordinator), MERGED, C102 OPENED (executeEnabled true; closed refusals via the closed-constants seam); closure = an INDEPENDENT transitive import scan of the twelve roots at the pin (+ package files), its framed digest recomputed; bare imports node:* + pg only; pg 8.18.0 in the lockfile", async () => {
  assert.equal(C.toolingCommit, PIN); assert.equal(C.toolingStatus, "MERGED"); assert.equal(C.executeEnabled, true, "C102 ENABLE");
  const roots = ["lib/booking-db/test-pipeline-coordinator.js", "lib/booking-db/repo.js", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/http-transports.mjs",
    "scripts/e7-connected/real-exchange.mjs", "lib/booking-db/pool.js", "lib/hostaway-reservations.js", "lib/checkout/capture-proof.js", "lib/checkout/recovery-plan.js",
    "lib/checkout/intent-state.js", "scripts/e7-connected/run-lock-precheck.mjs", "scripts/e7-connected/probe-env-preflight.mjs"];
  const seen = new Set(); const st = [...roots]; const bare = new Set();
  while (st.length) { const f = st.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const m of readFileSync(join(TOOLING, f), "utf8").matchAll(/(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const s = m[1] || m[2]; if (s.startsWith(".")) st.push(normalize(join(dirname(f), s))); else bare.add(s); } }
  assert.deepEqual([...seen, "package.json", "package-lock.json"].sort(), [...C.closure]);
  assert.ok([...bare].every((b) => b.startsWith("node:") || b === "pg"), [...bare].join(","));
  assert.equal(await E.framedDigest(TOOLING, C.closure, E.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
  const src = readFileSync(join(TOOLING, "lib/booking-db/test-pipeline-coordinator.js"), "utf8");
  assert.match(src, /syncChecks\(\);\s+\/\/ C88: re-checked after the await, immediately before the send/, "the accepted C88 guard amendment is in the pinned coordinator");
  assert.match(src, /export const TEST_LISTING_ID = 606998;/); assert.match(src, /export const WRITE_BUDGET = Object\.freeze\(\{ create: 1, capture: 1, record: 1 \}\);/);
  assert.match(src, /export const MAX_STEPS_LIMIT = 8;/); assert.ok(C.budgets.maxSteps <= 8);
});

test("H2 exclusions: the reviewed C82 protected intent set (abede8b1 / c83c1842 / C77 target 954d476c), the historical floor after the C82 END detail, protected reservations, the 28 migrated + never-public + pilot listings refused and disjoint from 606998", () => {
  // C100: + the C94 / C95 target 669da884; the floor moves after the C97 final snapshot / the C96 END read
  assert.deepEqual([...C.excludedIntentIds], ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309", "954d476c-71ea-4824-92f6-2220ae302103",
    "669da884-02e8-4105-8825-f908e5d22ae9"]);
  assert.ok(Date.parse(C.historicalFloor) > Date.parse("2026-11-15T21:18:30.000Z"));
  assert.deepEqual([...C.protectedReservationIds], ["70636076", "71045356", "71072615", "71081885"]);
  assert.equal(C.excludedListingIds.length, 32); assert.ok(!C.excludedListingIds.includes(606998));
  for (const id of [628346, 628372, 628400, 628381, 628387, 603564, 603566]) assert.ok(C.excludedListingIds.includes(id), String(id));
  const PUB = readFileSync(join(TOOLING, "lib/public-catalog.js"), "utf8");
  for (const m of PUB.matchAll(/\b(6283\d\d)\b/g)) assert.ok(C.excludedListingIds.includes(Number(m[1])), m[1]);
});

test("H3 labelled copies equal the reviewed runners: canonical / framedDigest / dbTargetOk / sessionLockUrl / OFFICIAL_CA (reservation runner), offlineChargeTitle / exactAmount (recording runner), candidateOf (reservation runner, sans admission pin)", async () => {
  for (const v of [null, 1, "x", [1, { b: 2, a: [3] }], { z: 1, a: { c: null, b: true } }]) assert.equal(E.canonical(v), RESRUN.canonical(v));
  assert.equal(await E.framedDigest(ROOT, ["scripts/e7-hosted-pipeline.mjs"], "p\n"), await RESRUN.framedDigest(ROOT, ["scripts/e7-hosted-pipeline.mjs"], "p\n"));
  for (const u of ["postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres", "postgresql://u:x@h:6543/postgres", "nope"]) {
    assert.equal(E.dbTargetOk(u), RESRUN.dbTargetOk(u)); assert.equal(E.sessionLockUrl(u), RESRUN.sessionLockUrl(u)); }
  assert.equal(E.OFFICIAL_CA_SHA256, RESRUN.OFFICIAL_CA_SHA256);
  for (const m of [1, 99, 100, 14000, 576001, 99999999]) assert.equal(E.exactAmount(m), RECRUN.exactAmount(m));
  assert.equal(E.offlineChargeTitle("x"), RECRUN.offlineChargeTitle("x"));
  const base = { intent: { reservation: null }, ops: [], hostaway: [] };
  const cases = [base, { intent: { reservation: { reservationId: 71999901 } }, ops: [{ op_type: "hostaway.create_reservation", state: "succeeded", result_ref: "71999901", late_result_ref: null, payload_rid: null }], hostaway: [] },
    { ...base, ops: [{ op_type: "hostaway.create_reservation", state: "succeeded", result_ref: "71999901", late_result_ref: "71999902", payload_rid: null }] },
    { ...base, hostaway: [{ rid: "70636076" }] }, { ...base, hostaway: [{ rid: "71999903" }] }];
  for (const f of cases) assert.deepEqual(E.candidateOf(f), RESRUN.candidateOf(f, { admission: "authorized" }), JSON.stringify(f));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// hosted wrapper
const SYNTH = {};
const realEnv = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_APPROVAL_REF: "ROOT-C90-label", E7_INTENT_ID: "11111111-2222-4333-8444-555555555555", E7_BOOKING_REF: "MV-FAKE0001",
  E7_EXPECTED_VERSION: "4", E7_NOT_BEFORE: "2026-11-16T00:00:00.000Z", E7_PAYMENT_INTENT_ID: "pi_FAKEpipeline001", E7_AMOUNT_MINOR: "14000", E7_CURRENCY: "USD", ...over });
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 9\n# pass 9\n# fail 0\n# skipped 0\n", truncated: false, spawnFailed: false });
test("H4 runHosted CLOSED (closed-constants seam; C102 ships opened): preflight (synthetic + real plan) passes with no secret; verify / execute refuse HPL_EXECUTE_CLOSED BEFORE any value read / import (spies untouched); secret / unexpected key / incomplete / invalid / excluded inputs refuse", async () => {
  const spies = { env: 0, tooling: 0, core: 0 };
  const deps = { spawnChild: okChild, importEnv: async (d) => { spies.env += 1; return tool("scripts/e7-connected/probe-env-preflight.mjs"); },
    importTooling: async () => { spies.tooling += 1; throw new Error("x"); }, runCore: async () => { spies.core += 1; return null; } };
  const s = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps });
  assert.deepEqual([s.exitCode, s.result.code, s.result.planKind, s.result.closureDigest], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", C.closureDigest], JSON.stringify(s.result));
  SYNTH.planHash = s.result.planHash; SYNTH.sourceDigest = s.result.sourceDigest;
  const rp = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps });
  assert.deepEqual([rp.exitCode, rp.result.code], [0, "PREFLIGHT_OK_REAL_PLAN"]); assert.notEqual(rp.result.planHash, s.result.planHash);
  assert.equal(rp.result.planHash, (await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps })).result.planHash, "deterministic");
  const before = { ...spies };
  const closed = { ...C, executeEnabled: false };                                                     // the exact CLOSE state (reverse patch) — refusal unchanged
  for (const mode of ["verify", "execute"]) {
    const x = await E.runHosted({ mode, env: realEnv({ E7_STRIPE_TEST_KEY: "sk_test_x", E7_RUN_ID: "1234567-1" }), proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: closed } });
    assert.deepEqual([x.exitCode, x.result.code, x.result.planHash, x.result.closureDigest], [1, "HPL_EXECUTE_CLOSED", null, null], mode);
  }
  assert.deepEqual(spies, before, "closed before any import / core");
  for (const [env, k] of [[{ E7_TOOLING_DIR: TOOLING, E7_HOSTAWAY_TOKEN: "t" }, "HPL_SECRET_SCOPE_VIOLATION"], [realEnv({ E7_RESERVATION_ID: "1" }), "HPL_INPUT_UNEXPECTED"],
    [realEnv({ E7_HPL_DB_TESTS: "1" }), "HPL_INPUT_UNEXPECTED"], [realEnv({ E7_AMOUNT_MINOR: "" }), "HPL_INPUT_INCOMPLETE"], [realEnv({ E7_CURRENCY: "MXN" }), "HPL_INPUT_INVALID"],
    [realEnv({ E7_BOOKING_REF: "MV-x" }), "HPL_INPUT_INVALID"], [realEnv({ E7_INTENT_ID: "954d476c-71ea-4824-92f6-2220ae302103" }), "HPL_INTENT_EXCLUDED"],
    [realEnv({ E7_INTENT_ID: "abede8b1-8ef6-44f2-876e-6a02fc056a96" }), "HPL_INTENT_EXCLUDED"], [realEnv({ E7_NOT_BEFORE: "2026-11-15T17:48:15.766Z" }), "HPL_INTENT_EXCLUDED"],
    [realEnv({ E7_INTENT_ID: C.synthetic.intentId }), "HPL_INPUT_INVALID"]]) {
    const x = await E.runHosted({ mode: "preflight", env, proc: PROC, wrapperDir: ROOT, deps });
    assert.deepEqual([x.exitCode, x.result.code], [1, k], JSON.stringify(Object.keys(env)));
  }
  const bad = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { ...deps, spawnChild: async () => ({ status: 1, signal: null, stdout: "# tests 3\n# pass 2\n# fail 1\n", truncated: false, spawnFailed: false }) } });
  assert.equal(bad.result.code, "HPL_TESTS_FAILED");
  const w = await E.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: { ...PROC, versions: { node: "22.21.0" } }, wrapperDir: ROOT, deps });
  assert.equal(w.result.code, "HPL_ENV_REFUSED");
});

test("H5 runHosted OPEN-CONSTANTS seam (test-local; the shipped constants stay closed): main-only, exact closure / source / plan digests, run id, credentials, dependency, DB target, CA; secrets REMOVED from env before the core; exit 0 only for a verified completion or a PENDING with nextActionAt", async () => {
  const open = { ...C, executeEnabled: true };
  const pre = await E.runHosted({ mode: "preflight", env: realEnv(), proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild, constants: open } });
  const DBU = "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
  const exec = (over = {}, deps = {}) => ({ GITHUB_REF: "refs/heads/main", ...realEnv({ E7_EXPECTED_PLAN_HASH: pre.result.planHash, E7_EXPECTED_SOURCE_DIGEST: pre.result.sourceDigest,
    E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_RUN_ID: "43746039485-1", E7_CA_FILE: "/ca", E7_STRIPE_TEST_KEY: "sk_test_x", E7_HOSTAWAY_TOKEN: "h", E7_DEV_BOOKING_DATABASE_URL: DBU, ...over }) });
  const seen = {};
  const fakeMods = { X: { createE7RealExchange: () => ({ ok: true, exchange: () => Promise.reject(new Error("no")) }) }, createBookingPool: () => ({ end: async () => {}, connect: async () => ({}) }), tooling: {} };
  const deps = (core) => ({ constants: open, readPgVersion: async () => "8.18.0", readCa: async () => Buffer.from("CA"), caSha256: createHash("sha256").update(Buffer.from("CA")).digest("hex"),
    importTooling: async () => fakeMods, runCore: async (inp) => { seen.inp = inp; return core; } });
  const env1 = exec();
  const ok = await E.runHosted({ mode: "execute", env: env1, proc: PROC, wrapperDir: ROOT, deps: deps({ outcome: "CONFIRMED_VERIFIED", verifiedCompletion: true }) });
  assert.deepEqual([ok.exitCode, ok.result.code, ok.result.cleanup, ok.result.lockEndpoint], [0, "EXECUTE_DONE", "POOLS_ENDED", "session:5432"], JSON.stringify(ok.result));
  for (const k of ["E7_STRIPE_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_DEV_BOOKING_DATABASE_URL"]) assert.ok(!(k in env1), `${k} removed from env`);
  assert.equal(seen.inp.credentials.stripe(), "sk_test_x"); assert.equal(seen.inp.runId, "43746039485-1"); assert.equal(seen.inp.plan.intentId, "11111111-2222-4333-8444-555555555555");
  assert.ok(!JSON.stringify(ok.result).includes("sk_test_x") && !JSON.stringify(ok.result).includes("pw@"));
  assert.equal((await E.runHosted({ mode: "execute", env: exec(), proc: PROC, wrapperDir: ROOT, deps: deps({ outcome: "PENDING", nextActionAt: "2026-11-16T00:02:00.000Z" }) })).exitCode, 0);
  assert.equal((await E.runHosted({ mode: "execute", env: exec(), proc: PROC, wrapperDir: ROOT, deps: deps({ outcome: "PENDING", nextActionAt: null }) })).exitCode, 1);
  assert.equal((await E.runHosted({ mode: "execute", env: exec(), proc: PROC, wrapperDir: ROOT, deps: deps({ outcome: "CONFIRMED_VERIFIED", verifiedCompletion: false }) })).exitCode, 1);
  assert.equal((await E.runHosted({ mode: "execute", env: exec(), proc: PROC, wrapperDir: ROOT, deps: deps({ outcome: "STOP" }) })).exitCode, 1);
  const v = await E.runHosted({ mode: "verify", env: exec({ E7_STRIPE_TEST_KEY: undefined }), proc: PROC, wrapperDir: ROOT, deps: deps(null) });
  assert.equal(v.result.code, "HPL_SECRET_SCOPE_VIOLATION", "verify never carries a secret key name");
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  const vv = await E.runHosted({ mode: "verify", env: strip(exec({ E7_STRIPE_TEST_KEY: undefined, E7_HOSTAWAY_TOKEN: undefined, E7_DEV_BOOKING_DATABASE_URL: undefined, E7_CA_FILE: undefined })), proc: PROC, wrapperDir: ROOT, deps: deps(null) });
  assert.equal(vv.result.code, "VERIFY_OK", JSON.stringify(vv.result));
  for (const [over, k, dx] of [[{ GITHUB_REF: "refs/heads/feature" }, "HPL_REF_NOT_MAIN"], [{ E7_EXPECTED_CLOSURE_DIGEST: "a".repeat(64) }, "HPL_CLOSURE_MISMATCH"],
    [{ E7_EXPECTED_SOURCE_DIGEST: "b".repeat(64) }, "HPL_SOURCE_MISMATCH"], [{ E7_EXPECTED_PLAN_HASH: "c".repeat(64) }, "HPL_PLAN_HASH_MISMATCH"], [{ E7_EXPECTED_VERSION: "5" }, "HPL_PLAN_HASH_MISMATCH"],
    [{ E7_RUN_ID: "x" }, "HPL_INPUT_INVALID"], [{ E7_EXPECTED_PLAN_HASH: "" }, "HPL_INPUT_INCOMPLETE"], [{ E7_HOSTAWAY_TOKEN: "" }, "HPL_CREDENTIALS_MISSING"],
    [{ E7_DEV_BOOKING_DATABASE_URL: "postgresql://postgres:pw@db.example.com:5432/postgres" }, "HPL_DB_TARGET_INVALID"], [{}, "HPL_CA_INVALID", { caSha256: "0".repeat(64) }],
    [{}, "HPL_DEPENDENCY_MISMATCH", { readPgVersion: async () => "8.17.0" }]]) {
    const x = await E.runHosted({ mode: "execute", env: { ...exec(), ...over }, proc: PROC, wrapperDir: ROOT, deps: { ...deps(null), ...(dx ?? {}) } });
    assert.deepEqual([x.exitCode, x.result.code, x.result.core], [1, k, null], JSON.stringify(over));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// pure proofs / checks
const IID = "11111111-2222-4333-8444-555555555555"; const PI = "pi_FAKEpipeline001"; const AMT = 14000; const ATT = "a1"; const CB = Date.UTC(2026, 10, 22, 15, 0, 0);
const intentAuth = (o = {}) => ({ id: IID, status: "reservation_confirmed", version: 7, listingId: 606998, ref: "MV-FAKE0001", from: "2026-11-25", to: "2026-11-26", guests: 1,
  createdAt: Date.parse("2026-11-16T01:00:00.000Z"), price: { currency: "USD", finalTotalMinor: AMT, rateBps: 1000 },
  payment: { paymentIntentId: PI, livemode: false, capturedMinor: 0, amountMinor: AMT, currency: "USD", captureBefore: CB }, reservation: { reservationId: 71999901 }, counters: { captureAttempts: 1 }, ...o });
const piObj = (o = {}, ch = {}) => ({ object: "payment_intent", id: PI, livemode: false, status: "requires_capture", capture_method: "manual", amount: AMT, amount_received: 0, amount_capturable: AMT,
  currency: "usd", metadata: { mv_intent_id: IID, mv_payment_attempt_id: ATT }, ...o,
  latest_charge: { object: "charge", id: "ch_FAKEpipe01", payment_intent: PI, status: "succeeded", paid: true, captured: false, amount: AMT, amount_captured: 0, amount_refunded: 0,
    refunded: false, disputed: false, currency: "usd", livemode: false, payment_method_details: { card: { capture_before: CB / 1000 } }, ...ch } });
const capturedPi = (o = {}, ch = {}) => piObj({ status: "succeeded", amount_received: AMT, amount_capturable: 0, ...o }, { captured: true, amount_captured: AMT, ...ch });
test("H6 fresh proofs (accepted v3 + captured predicates + raw refusals): authorized / captured pass; amount / currency / livemode / manual capture / metadata / status / refund (amount, flag, listed) / dispute / multicapture / capture_before mismatch refuse", () => {
  const P = (k, pi, i = intentAuth()) => E.proofRefusal(k, pi, i, ATT, pureTooling, 1);
  assert.equal(P("authorized", piObj()), null);
  assert.equal(P("captured", capturedPi(), intentAuth({ status: "payment_captured", payment: { ...intentAuth().payment, capturedMinor: AMT } })), null);
  for (const [k, pi, want] of [["authorized", piObj({ amount: AMT + 1 }), "PAYMENT_INTENT_IDENTITY"], ["authorized", piObj({ currency: "mxn" }), "PAYMENT_INTENT_IDENTITY"],
    ["authorized", piObj({ livemode: true }), "PAYMENT_INTENT_IDENTITY"], ["authorized", piObj({ capture_method: "automatic" }), "PAYMENT_INTENT_IDENTITY"],
    ["authorized", piObj({ metadata: { mv_intent_id: "other", mv_payment_attempt_id: ATT } }), "PAYMENT_INTENT_IDENTITY"], ["authorized", piObj({ status: "canceled" }), "NOT_REQUIRES_CAPTURE"],
    ["authorized", capturedPi(), "NOT_REQUIRES_CAPTURE"], ["authorized", piObj({}, { amount_refunded: 1 }), "CHARGE_REFUNDED"], ["authorized", piObj({}, { refunded: true }), "CHARGE_REFUNDED_FLAG"],
    ["authorized", piObj({}, { refunded: undefined }), "CHARGE_REFUNDED_FLAG"], ["authorized", piObj({}, { refunds: { data: [{ id: "re_1" }] } }), "CHARGE_REFUND_LISTED"],
    ["authorized", piObj({}, { disputed: true }), "CHARGE_DISPUTED"], ["authorized", piObj({}, { disputed: "true" }), "CHARGE_DISPUTE_UNKNOWN"], ["authorized", piObj({}, { payment_method_details: { card: { capture_before: CB / 1000, multicapture: { status: "available" } } } }), "MULTICAPTURE_AVAILABLE"],
    ["authorized", piObj({ payment_method_options: { card: { request_multicapture: "if_available" } } }), "MULTICAPTURE_REQUESTED"],
    ["authorized", piObj({}, { payment_method_details: { card: { capture_before: CB / 1000 + 60 } } }), "CAPTURE_BEFORE_MISMATCH"], ["authorized", piObj({}, { captured: true }), "CHARGE_ALREADY_CAPTURED"],
    ["captured", piObj(), "PI_NOT_CAPTURED_PROOF"], ["captured", capturedPi({}, { amount_refunded: 100 }), "PI_NOT_CAPTURED_PROOF"], ["captured", capturedPi({}, { refunded: true }), "CHARGE_REFUNDED_FLAG"],
    ["captured", capturedPi({ amount_received: AMT - 1 }), "PI_NOT_CAPTURED_PROOF"], ["captured", capturedPi({ amount_capturable: 1 }), "PI_CAPTURED_SHAPE"],
    ["authorized", { ...piObj(), latest_charge: "ch_x" }, "CHARGE_NOT_EXPANDED"]]) assert.equal(P(k, pi), want, `${k} ${want}`);
  // C91-F2 (ROOT review 5912770410): the no-dispute proof needs the explicit typed false; absent / malformed = unknown = refused, authorized AND captured
  const capI = intentAuth({ status: "payment_captured", payment: { ...intentAuth().payment, capturedMinor: AMT } });
  const noDisp = (pi) => { const x = structuredClone(pi); delete x.latest_charge.disputed; return x; };
  for (const v of ["true", "false", 1, 0, {}, [], null]) {
    assert.equal(P("authorized", piObj({}, { disputed: v })), "CHARGE_DISPUTE_UNKNOWN", `authorized disputed=${JSON.stringify(v)}`);
    assert.equal(P("captured", capturedPi({}, { disputed: v }), capI), "CHARGE_DISPUTE_UNKNOWN", `captured disputed=${JSON.stringify(v)}`);
  }
  assert.equal(P("authorized", noDisp(piObj())), "CHARGE_DISPUTE_UNKNOWN"); assert.equal(P("captured", noDisp(capturedPi()), capI), "CHARGE_DISPUTE_UNKNOWN");
  assert.equal(P("captured", capturedPi({}, { disputed: true }), capI), "CHARGE_DISPUTED");
  assert.equal(piObj().latest_charge.disputed, false, "realistic fixtures carry the explicit false"); assert.equal(P("captured", capturedPi(), capI), null, "typed false control");
  assert.equal(E.sanitizeNextActionAt(Date.UTC(2026, 10, 16), Date.UTC(2026, 10, 16) - 120000), "2026-11-16T00:00:00.000Z");
  for (const v of [null, NaN, 1.5, -1, 0, Date.UTC(2026, 11, 30), Date.UTC(2026, 9, 1)]) assert.equal(E.sanitizeNextActionAt(v, Date.UTC(2026, 10, 16)), null, String(v));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// FAKE core: tagged-SELECT DB + scripted coordinator (outcome mapping, admission, lock) — the REAL proofs / transports / adapters
const plan = (over = {}) => E.buildPlan(C, { approvalRef: "SYNTHETIC-hpl-unit", intentId: IID, ref: "MV-FAKE0001", expectedVersion: 7, notBefore: "2026-11-16T00:00:00.000Z",
  paymentIntentId: PI, amountMinor: AMT, currency: "USD", sourceDigest: "0".repeat(64), ...over }).plan;
const opRow = (op_type, o = {}) => ({ op_type, state: "succeeded", attempts: 1, dispatched: true, result_ref: null, late_result_ref: null, idempotency_key: null, payload_rid: null, payload_pi: null, payload_amount: null, payload_key: null, ...o });
function fworld(o = {}) {
  const w = { status: o.status ?? "reservation_confirmed", version: 7, och: null, ops: [opRow("hostaway.create_reservation", { result_ref: "71999901" }),
    opRow("stripe.capture_payment_intent", { state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` })],
    evidence: o.evidence ?? [], claims: [{ listing_id: 606998, released: false }], cases: 0, calls: [], pi: o.pi ?? piObj(), unlock: 0 };
  return w;
}
function fpool(w, o = {}) {
  const tag = (sql) => /\/\*e7hpl:(\w+)\*\//.exec(sql)?.[1];
  const p = { async query(sql) {
    switch (tag(sql)) {
      case "instance": return { rows: [{ environment: "test" }] };
      case "row": return { rows: [{ state: w.status, version: w.version, listing_id: 606998, rid: "71999901", och: o.och ?? w.och }] };
      case "attempts": return { rows: [{ id: ATT, status: "completed", payment_intent_id: PI, livemode: false }] };
      case "hostaway": return { rows: [{ state: "succeeded", rid: "71999901" }] };
      case "ops": return { rows: w.ops.map((x) => ({ ...x })) };
      case "cases": return { rows: [{ n: w.cases }] };
      case "claims": return { rows: w.claims };
      case "evidence": return { rows: w.evidence };
      case "work": return { rows: w.work ?? [{ next_action_at: null, work_worker_id: null, work_lease_until: null }] };
      case "holds": if (w.holdsQuery) return w.holdsQuery(); return { rows: [{ n: w.holds ?? 0 }] };
      case "inbox": return { rows: [{ n: w.inbox ?? 0 }] };
      case "guest": return { rows: [{ first_name: "Fake", last_name: "Guest", email: "fake.guest@example.test" }] };
      case "role": return { rows: [{ is_app: true, privileged: false }] };
      case "identity": return { rows: [{ db: "fake", environment: "test" }] };
      default: throw new Error(`unexpected SQL ${String(sql).slice(0, 50)}`);
    }
  }, async connect() { return { query: (sql, params) => p.query(sql, params), release() {}, on() {} }; } };
  p.lock = () => ({ async query(sql, params) {
    if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: !o.lockHeld, pid: 4242 }] };
    if (/pg_advisory_unlock/.test(sql)) { w.unlock += 1; return { rows: [{ ok: true, pid: 4242 }] }; }
    if (/pg_backend_pid\(\) AS pid/.test(sql) && /AS n/.test(sql)) { assert.deepEqual(params, [LK.LOCK_KEY]); return { rows: [{ n: 1, pid: 4242 }] }; }
    if (/e7hpl:identity/.test(sql)) return { rows: [{ db: "fake", environment: "test" }] };
    throw new Error(`unexpected lock SQL ${sql.slice(0, 40)}`);
  }, release(d) { w.released = d === true ? "destroyed" : "pooled"; }, on() {} });
  return p;
}
const fexchanges = (w) => ({
  stripe: (req) => { w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
    return Promise.resolve({ status: 200, contentType: "application/json", bytes: enc(req.url.endsWith("/v1/account") ? { object: "account", id: C.accountId } : w.pi) }); },
  hostaway: (req) => { w.calls.push(`H ${req.method} ${req.url.replace("https://api.hostaway.com", "")}`); return Promise.resolve({ status: 404, contentType: "application/json", bytes: enc({ status: "fail" }) }); }
});
const CAPTURED = {};
const fcore = (w, co, o = {}) => E.runPipelineCore({ plan: plan(o.plan), pool: o.pool ?? fpool(w, o), lockClientFactory: o.lockClientFactory ?? (async () => fpool(w, o).lock()), runId: "unit-run-0001",
  tooling: { ...pureTooling, loadIntent: async () => intentAuth({ status: w.status, version: w.version, lease: w.lease ?? null, payment: { ...intentAuth().payment, capturedMinor: w.status === "confirmed" ? AMT : 0 } }),
    runTestPipelineCoordinator: async (pool, opts) => { w.coOpts = opts; if (o.coordinatorExtra) await o.coordinatorExtra(opts); if (typeof co === "function") return co(w, opts, pool); return co; } },
  exchanges: fexchanges(w), credentials: { stripe: () => "sk_test_fake", hostaway: () => "tok" }, clock: () => Date.UTC(2026, 10, 16, 2), ...(o.extra ?? {}) });
test("H7 FAKE core: admission refusals BEFORE the lock (stored refund veto / invalid refund evidence / wrong version / open case / released claim / dispatched notify / excluded id) and start-proof refusal — zero provider calls, no coordinator", async () => {
  for (const [mk, k] of [[() => fworld({ evidence: [{ kind: "payment_intent", external_ref: PI, observed: { amountRefundedMinor: 500 } }] }), "ADMISSION_REFUSED:PAYMENT_REFUND_OBSERVED"],
    [() => fworld({ evidence: [{ kind: "payment_intent", external_ref: PI, observed: { refunded: "yes" } }] }), "ADMISSION_REFUSED:PAYMENT_REFUND_EVIDENCE_INVALID"],
    [() => { const w = fworld(); w.version = 8; return w; }, "ADMISSION_REFUSED:VERSION_NOT_PINNED"], [() => { const w = fworld(); w.cases = 1; return w; }, "ADMISSION_REFUSED:OPEN_CASE"],
    [() => { const w = fworld(); w.claims = [{ listing_id: 606998, released: true }]; return w; }, "ADMISSION_REFUSED:CLAIM_NOT_HELD"],
    [() => { const w = fworld(); w.ops.push(opRow("guest.notify", { dispatched: true })); return w; }, "ADMISSION_REFUSED:NOTIFY_DISPATCHED"],
    [() => { const w = fworld(); w.ops.push(opRow("stripe.void_payment_intent")); return w; }, "ADMISSION_REFUSED:FORBIDDEN_OP_PRESENT"],
    [() => { const w = fworld(); w.status = "capture_unknown"; return w; }, "ADMISSION_REFUSED:STATE_NOT_IN_PIPELINE"]]) {
    const w = mk(); let called = 0;
    const r = await fcore(w, () => { called += 1; return {}; });
    assert.deepEqual([r.outcome, r.code, w.calls.length, called, r.coordinatorInvocations, r.lock], ["STOP", k, 0, 0, 0, "not_acquired"], k);
  }
  { const w = fworld(); const r = await fcore(w, {}, { plan: { intentId: "954d476c-71ea-4824-92f6-2220ae302103" } }); assert.deepEqual([r.outcome, r.code, w.calls.length], ["STOP", "CORE_INVALID", 0]); }
  { const w = fworld(); const r = await fcore(w, {}, { lockHeld: true }); assert.deepEqual([r.code, w.calls.length, r.coordinatorInvocations], ["LOCK_NOT_ACQUIRED:RUN_LOCK_PRESENT", 0, 0]); }
  { const w = fworld({ pi: piObj({ status: "canceled" }) }); let called = 0; const r = await fcore(w, () => { called += 1; return {}; });
    assert.deepEqual([r.code, called, r.lock, w.unlock], ["PROVIDER_PROOF_FAILED:NOT_REQUIRES_CAPTURE", 0, "released", 1]); assert.deepEqual(w.calls, ["S GET /v1/account", `S GET /v1/payment_intents/${PI}?expand%5B%5D=latest_charge`]); }
});

test("H8 FAKE core outcome mapping: ONE coordinator call with the bound phases / gates; CONFIRMED + failing durable postcheck → STOP POSTCHECK_MISMATCH (never success); PENDING → sanitized nextActionAt, else STOP; coordinator STOP after an attempted write → possiblyEffected; executors are the exact accepted key sets", async () => {
  { const w = fworld(); const r = await fcore(w, (ww) => { ww.status = "confirmed"; return { outcome: "CONFIRMED", code: "CONFIRMED", steps: [], writes: { create: 0, capture: 1, record: 1 } }; });
    assert.deepEqual([r.outcome, r.verifiedCompletion, r.coordinatorInvocations], ["STOP", false, 1]); assert.match(r.code, /^POSTCHECK_MISMATCH:/, r.code);
    const o = w.coOpts;
    assert.deepEqual(o.env, { VERCEL_ENV: "development", MV_E7_TEST_PIPELINE_COORDINATOR: "enabled", MV_E7_RESERVATION_WORKER: "enabled", MV_E7_CAPTURE_WORKER: "enabled", MV_E7_RECORDING_WORKER: "enabled", DIRECT_DISCOUNT_BPS: "1000" });
    assert.deepEqual(o.binding, { intentId: IID, ref: "MV-FAKE0001" }); assert.equal(o.maxSteps, 6); assert.equal(typeof o.hooks.afterStep, "function"); assert.ok(o.signal instanceof AbortSignal);
    assert.ok(Number.isFinite(o.deadlineAt));
    for (const p of ["reservation", "capture", "recording"]) assert.deepEqual([...o.phases[p].listings.keys()], [606998], p);
    assert.deepEqual(Object.keys(o.phases.reservation.executors).sort(), [...EA.PHASE_KEYS.reservation].sort());
    assert.deepEqual(Object.keys(o.phases.capture.executors).sort(), [...EA.PHASE_KEYS.capture].sort());
    assert.deepEqual(Object.keys(o.phases.recording.executors).sort(), [...EA.PHASE_KEYS.recording].sort());
    assert.equal(o.phases.capture.stripeAccountId, C.accountId); assert.deepEqual(o.phases.recording.executors.label, { accountRef: "hostaway-e7-test", clientSnapshotId: "unit-run-0001" });
    CAPTURED.opts = o; }
  { const w = fworld(); const NA = Date.UTC(2026, 10, 16, 2, 2); const r = await fcore(w, { outcome: "PENDING", code: "NOT_DUE", steps: [], writes: { create: 0, capture: 0, record: 0 }, nextActionAt: NA });
    assert.deepEqual([r.outcome, r.code, r.nextActionAt, r.possiblyEffected], ["PENDING", "PENDING:NOT_DUE", new Date(NA).toISOString(), false]); }
  for (const na of [null, Date.UTC(2027, 5, 1)]) { const w = fworld(); const r = await fcore(w, { outcome: "PENDING", code: "NOT_DUE", steps: [], writes: { create: 0, capture: 0, record: 0 }, nextActionAt: na });
    assert.deepEqual([r.outcome, r.code, r.nextActionAt], ["STOP", "PENDING_NEXT_ACTION_INVALID:NOT_DUE", null]); }
  { const w = fworld(); const r = await fcore(w, { outcome: "STOP", code: "CAPTURE_UNKNOWN", steps: [], writes: { create: 0, capture: 1, record: 0 } });
    assert.deepEqual([r.outcome, r.code, r.possiblyEffected, r.verifiedCompletion], ["STOP", "COORDINATOR_STOP:CAPTURE_UNKNOWN", true, false]); }
  { const w = fworld(); const r = await fcore(w, async (ww, o) => { await o.phases.capture.executors.capturePaymentIntent(PI, { amount_to_capture: AMT + 1, expand: ["latest_charge"] }, { idempotencyKey: `cap:${IID}:${PI}` }).catch(() => {});
      return { outcome: "STOP", code: "STEP_THREW_X", steps: [], writes: { create: 0, capture: 0, record: 0 } }; });
    assert.equal(w.calls.filter((x) => x.startsWith("S POST")).length, 0, "the adapter refused the off-plan capture before the fence"); assert.equal(r.sends.capture, 0); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C91-F1 (ROOT review 5912770410) — the reproducer: a never-settling DB await must NOT outlive the run deadline; local connect / statement bounds;
// late clients / results never resume a stage. Timer seam: "deadline" and "db" timers are captured and fired by the test; the rest are real.
const timers = () => {
  const T = { deadline: [], db: [] };
  T.timer = (fn, ms, kind) => { if (kind === "deadline" || kind === "db") { const h = { fn, kind, ms, cleared: false }; T[kind].push(h); return h; } return setTimeout(fn, ms); };
  T.clearTimer = (h) => { if (h && typeof h === "object" && "kind" in h) h.cleared = true; else clearTimeout(h); };
  T.live = (kind) => T[kind].filter((h) => !h.cleared);
  T.fire = (kind) => { const h = T.live(kind).at(-1); assert.ok(h, `a live ${kind} timer`); h.cleared = true; h.fn(); };
  return T;
};
const deferred = () => { let res; let rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** a fake pool whose client query for `stallTag` (or every connect, or the lock proof) never settles until the test resolves it LATE */
function stallPool(w, o = {}) {
  const base = fpool(w, o); const st = { destroyed: 0, lateUsed: 0, pending: [], connects: [] };
  const wrap = (cl) => ({ query: (sql, params) => { if (st.sealedSeen) st.lateUsed += 1;
      if (o.stallTag && new RegExp(`e7hpl:${o.stallTag}\\*`).test(String(sql))) { const d = deferred(); st.pending.push({ d, sql, params, cl }); return d.p; }
      return cl.query(sql, params); },
    release: (x) => { if (x === true) st.destroyed += 1; }, on() {} });
  st.pool = { query: () => { throw new Error("pool.query must not be used: every statement goes through a tracked client"); },
    connect: () => { if (o.stallConnect) { const d = deferred(); st.connects.push(d); return d.p; } return base.connect().then(wrap); } };
  st.lateClient = () => ({ query: () => { st.lateUsed += 1; return Promise.resolve({ rows: [] }); }, release: (x) => { if (x === true) st.destroyed += 1; }, on() {} });
  return st;
}
const race40 = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("STILL_PENDING_AFTER_DEADLINE"), 40))]);
test("H9 C91-F1 never-settling DB awaits: an admission query / connect / lock acquisition / lock proof that never settles is SEALED by the deadline (STOP within 40 ms, not pending), its connection destroyed; the LATE completion is discarded (a late client is destroyed, never used); zero provider calls; no coordinator", async () => {
  for (const [label, mk] of [
    ["admission query", (w) => ({ st: stallPool(w, { stallTag: "row" }) })],
    ["connect", (w) => ({ st: stallPool(w, { stallConnect: true }) })],
    ["lock acquisition", (w) => { const st = stallPool(w); const d = deferred(); st.lockD = d; return { st, lockClientFactory: () => d.p }; }],
    ["lock proof", (w) => { const st = stallPool(w); const lk = fpool(w).lock(); const d = deferred(); st.lockProof = d;
      return { st, lockClientFactory: async () => ({ query: (sql, p2) => (/AS n/.test(sql) && /pg_backend_pid/.test(sql) ? d.p : lk.query(sql, p2)), release: (x) => { if (x === true) st.destroyed += 1; }, on() {} }) }; }]]) {
    const w = fworld(); const T = timers(); const m = mk(w); let coordinatorCalls = 0;
    const core = fcore(w, () => { coordinatorCalls += 1; return {}; }, { pool: m.st.pool, lockClientFactory: m.lockClientFactory, extra: { timer: T.timer, clearTimer: T.clearTimer } });
    await tick(20);
    assert.equal(await race40(core), "STILL_PENDING_AFTER_DEADLINE", `${label}: genuinely stalled before the deadline`);
    T.fire("deadline");
    const r = await race40(core);
    assert.notEqual(r, "STILL_PENDING_AFTER_DEADLINE", `${label}: the seal ends the run`);
    assert.deepEqual([r.outcome, r.code, r.sealed, r.sealReason, r.coordinatorInvocations, coordinatorCalls], ["STOP", "STOP_DEADLINE", true, "DEADLINE", 0, 0], `${label}: ${JSON.stringify(r)}`);
    assert.equal(r.possiblyEffected, false, `${label}: runner reads before the coordinator are read-only`);
    const callsAtSeal = w.calls.length; m.st.sealedSeen = true;
    if (label === "admission query") { assert.ok(r.clientsDestroyed >= 1 && m.st.destroyed >= 1, "the stalled connection is destroyed"); m.st.pending[0].d.res({ rows: [] }); }
    if (label === "connect") m.st.connects[0].res(m.st.lateClient());
    if (label === "lock acquisition") m.st.lockD.res(m.st.lateClient());
    if (label === "lock proof") { assert.equal(r.lock, "sealed_connection_destroyed"); m.st.lockProof.res({ rows: [{ n: 1, pid: 4242 }] }); }
    await tick(20);
    if (label === "connect" || label === "lock acquisition") assert.equal(m.st.destroyed, 1, `${label}: the LATE client is destroyed before any use`);
    assert.equal(m.st.lateUsed, 0, `${label}: nothing ran on a late client / after the seal`); assert.equal(w.calls.length, callsAtSeal, `${label}: no provider call after the seal`);
    assert.equal(T.live("db").length, 0, `${label}: every local bound timer cleared`);
  }
});
test("H10 C91-F1 LOCAL bounds + mid-coordinator seal: a statement / connect past its local bound SEALS (STOP_DB_STATEMENT_TIMEOUT / STOP_DB_CONNECT_TIMEOUT) and destroys the connection; a coordinator stalled on a DB statement at the deadline → STOP, UNKNOWN DB outcome ⇒ possiblyEffected, and the still-running sealed coordinator can reach NO DB / provider (its calls refuse, late result discarded)", async () => {
  { const w = fworld(); const T = timers(); const st = stallPool(w, { stallTag: "attempts" });
    const core = fcore(w, {}, { pool: st.pool, extra: { timer: T.timer, clearTimer: T.clearTimer } }); await tick(20);
    const h = T.live("db").find((x) => x.ms === C.budgets.statementMs); assert.ok(h, "the stalled statement carries the local statement bound"); h.cleared = true; h.fn();
    const r = await race40(core);
    assert.deepEqual([r.outcome, r.code, r.sealed, w.calls.length, st.destroyed >= 1], ["STOP", "STOP_DB_STATEMENT_TIMEOUT", true, 0, true], JSON.stringify(r)); }
  { const w = fworld(); const T = timers(); const st = stallPool(w, { stallConnect: true });
    const core = fcore(w, {}, { pool: st.pool, extra: { timer: T.timer, clearTimer: T.clearTimer } }); await tick(20);
    const h = T.live("db").find((x) => x.ms === C.budgets.connectMs); assert.ok(h, "acquisition carries the local connect bound"); h.cleared = true; h.fn();
    const r = await race40(core); assert.deepEqual([r.outcome, r.code, w.calls.length], ["STOP", "STOP_DB_CONNECT_TIMEOUT", 0], JSON.stringify(r));
    st.connects[0].res(st.lateClient()); await tick(10); assert.deepEqual([st.destroyed, st.lateUsed], [1, 0], "late client destroyed, never used"); }
  { const w = fworld(); const T = timers(); const st = stallPool(w, { stallTag: "stall" }); const after = {}; const settled = deferred();
    const core = fcore(w, async (ww, o, pool) => {
      let threw = null;
      try { await pool.query("/*e7hpl:stall*/ SELECT 1"); } catch (e) { threw = e; }                // a DB statement in flight when the deadline seals
      try { await pool.query("/*e7hpl:instance*/ SELECT environment FROM booking.instance"); after.query = "RAN"; } catch { after.query = "REFUSED"; }
      try { await o.phases.capture.executors.retrieveAccount({}); after.executor = "RAN"; } catch { after.executor = "REFUSED"; }
      try { await o.hooks.afterStep({ phase: "reservation", stateBefore: "payment_authorized", stateAfter: "reservation_confirmed" }); after.hook = "RAN"; } catch { after.hook = "REFUSED"; }
      after.threw = threw ? threw.code ?? "ERR" : null; settled.res();
      return { outcome: "CONFIRMED", code: "CONFIRMED", steps: [], writes: { create: 1, capture: 0, record: 0 } };   // a late "CONFIRMED" must never be success
    }, { pool: st.pool, extra: { timer: T.timer, clearTimer: T.clearTimer } });
    for (let i = 0; i < 50 && st.pending.length === 0; i++) await tick(5);
    assert.equal(st.pending.length, 1, "the coordinator holds ONE statement in flight");
    const callsBefore = w.calls.length;
    T.fire("deadline");
    const r = await race40(core);
    assert.notEqual(r, "STILL_PENDING_AFTER_DEADLINE");
    assert.deepEqual([r.outcome, r.code, r.sealed, r.dbInFlightAtSeal, r.dbOutcomeUnknown, r.possiblyEffected, r.verifiedCompletion, r.coordinatorInvocations],
      ["STOP", "STOP_DEADLINE", true, 1, true, true, false, 1], JSON.stringify(r));
    assert.ok(st.destroyed >= 1, "the coordinator's in-flight connection is destroyed");
    await settled.p; st.pending[0].d.res({ rows: [{ x: 1 }] }); await tick(10);
    assert.deepEqual(after, { query: "REFUSED", executor: "REFUSED", hook: "REFUSED", threw: "RUNNER_STOPPED" }, "the sealed coordinator reaches nothing");
    assert.equal(w.calls.length, callsBefore, "no provider call after the seal"); assert.equal(r.coordinatorSettled, true);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// C100: the ONE bounded continuation of the healthy PENDING NOT_DUE branch (FAKE core: scripted coordinator, tagged-SELECT DB, fake clock / wait)
const T_BASE = Date.UTC(2026, 10, 16, 2);
/** a healthy first-invocation PENDING NOT_DUE world: reservation_pending, ONE settled succeeded create, no capture / record row, due in 120 s */
function pworld(o = {}) {
  const w = fworld(); w.status = "reservation_pending"; w.version = 6;
  w.ops = [opRow("hostaway.create_reservation", { result_ref: "71999901" })];
  w.due = T_BASE + (o.dueInMs ?? 120000);
  w.work = [{ next_action_at: new Date(w.due), work_worker_id: null, work_lease_until: null }];
  return w;
}
/** clock + timer seam: "wait" timers ADVANCE the fake clock by their ms (unless frozen) and fire; deadline / db timers are captured; others real */
function ptimers(clk, o = {}) {
  const T = timers(); const base = T.timer;
  T.waits = [];
  T.timer = (fn, ms, kind) => {
    if (kind === "wait") { const h = { fn, kind, ms, cleared: false }; T.waits.push(h); if (!o.holdWait) setImmediate(() => { if (!h.cleared) { if (!o.freezeClock) clk.t += ms; h.cleared = true; fn(); } }); return h; }
    return base(fn, ms, kind);
  };
  return T;
}
const pending1 = (w) => ({ outcome: "PENDING", code: "NOT_DUE", steps: [{ phase: "reservation", status: "worked", stateBefore: "payment_authorized", stateAfter: "reservation_pending" }],
  writes: { create: 1, capture: 0, record: 0 }, nextActionAt: w.due });
/** run the fake core with a scripted coordinator `script[i](w, opts, pool)` per invocation */
function pcore(w, script, o = {}) {
  const clk = { t: T_BASE }; const T = ptimers(clk, o); let calls = 0;
  const run = fcore(w, async (ww, opts, pool) => { const f = script[calls] ?? (() => { throw new Error("third invocation"); }); calls += 1; return f(ww, opts, pool); },
    { plan: { expectedVersion: 6 }, extra: { clock: () => clk.t, timer: T.timer, clearTimer: T.clearTimer, ...(o.extra ?? {}) }, ...(o.core ?? {}) });
  return { run, clk, T, calls: () => calls };
}
test("H11 C100 eligibility: ONLY a healthy PENDING NOT_DUE (reservation_pending + ONE settled create, no capture / record, due ≤ 150 s, reserve, no foreign live lease, no unknown) waits; every other first result returns the existing PENDING / STOP with ONE invocation and NO wait", async () => {
  const cases = [
    ["code DEADLINE_RESERVE", (w) => {}, (w) => ({ ...pending1(w), code: "DEADLINE_RESERVE" }), "NOT_PENDING_NOT_DUE"],
    ["state reservation_confirmed", (w) => { w.status = "reservation_confirmed"; }, pending1, "STATE_NOT_RESERVATION_PENDING"],
    ["create not settled", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { state: "pending", attempts: 0, dispatched: false, result_ref: null }); }, pending1, "CREATE_NOT_SINGLE_SETTLED"],
    ["create late-result conflict", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { result_ref: "71999901", late_result_ref: "71999902" }); }, pending1, null],
    ["capture attempted", (w) => { w.ops.push(opRow("stripe.capture_payment_intent", { state: "failed_definite", payload_pi: PI, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` })); }, pending1, "WRITE_ROW_NOT_PRISTINE"],
    ["due beyond 150 s", (w) => { w.due = T_BASE + 150001; w.work[0].next_action_at = new Date(w.due); }, pending1, "DUE_OUT_OF_RANGE"],
    ["due not bound", (w) => {}, (w) => ({ ...pending1(w), nextActionAt: w.due + 1000 }), "DUE_NOT_BOUND"],
    ["no work row", (w) => { w.work = []; }, pending1, "WORK_ROW_MISSING"],
    ["foreign live work lease", (w) => { w.work[0].work_worker_id = "someone-else:res"; w.work[0].work_lease_until = new Date(T_BASE + 60000); }, pending1, "LIVE_FOREIGN_WORK_LEASE"],
    ["foreign live intent lease", (w) => { w.lease = { workerId: "other-worker:res", until: T_BASE + 60000 }; }, pending1, "LIVE_FOREIGN_INTENT_LEASE"],
    ["own lease outliving due", (w) => { w.lease = { workerId: "e7-hpl:SYNTHETIC-hpl-unit:res", until: w.due + 1 }; }, pending1, "LIVE_FOREIGN_INTENT_LEASE"],
  ];
  for (const [label, mut, co1, reason] of cases) {
    const w = pworld();
    const p = pcore(w, [(ww) => { mut(ww); return co1(ww); }]); const r = await p.run;                // the facts the FIRST invocation leaves behind
    assert.equal(p.calls(), 1, `${label}: ONE invocation`); assert.equal(r.waits, 0, `${label}: no wait`); assert.equal(p.T.waits.length, 0, label);
    if (reason) { assert.equal(r.outcome, "PENDING", `${label}: ${JSON.stringify(r)}`); assert.deepEqual([r.continuation.eligible, r.continuation.reason], [false, reason], label); }
    else { assert.ok(r.outcome === "PENDING" || r.outcome === "STOP", label); assert.ok(!r.continuation || r.continuation.eligible === false, label); }
  }
  { const w = pworld(); const p = pcore(w, [(ww) => { ww.cases = 1; return pending1(ww); }]); const r = await p.run;
    assert.deepEqual([r.outcome, r.code, p.calls(), r.waits], ["STOP", "PENDING_FACTS_OPEN_CASE", 1, 0], "open case: never waits"); }
  { const w = pworld(); let late = false;                                                            // the first invocation used most of the whole-run budget
    const p = pcore(w, [(ww) => { late = true; return pending1(ww); }], { extra: { now: () => (late ? T_BASE + C.budgets.runMs - C.budgets.teardownMs - 100000 : T_BASE) } });
    const r = await p.run; assert.deepEqual([r.outcome, r.continuation && r.continuation.reason, r.waits, p.calls()], ["PENDING", "NO_RUN_RESERVE", 0, 1], JSON.stringify(r)); }
});
test("H12 C100 continuation: healthy PENDING NOT_DUE → ONE bounded wait (fake clock, no real sleep) → fresh re-admission (own lock, same version / create / due, refund veto, FRESH Stripe proof, recovery executors bound to the durable rid) → second invocation; a second PENDING exits PENDING (no third invocation / wait); counters / results reported per invocation + cumulative", async () => {
  const w = pworld();
  const p = pcore(w, [pending1, async (ww, o) => {
    assert.equal(typeof o.phases.reservation.executors.createReservation, "function");
    const c2 = await o.phases.reservation.executors.createReservation({ method: "POST", path: "/v1/reservations", query: {}, body: {} }).then(() => "SENT", (e) => "REFUSED");
    assert.equal(c2, "REFUSED", "the continuation's reservation executors never create (recovery factory + cumulative fence)");
    return { outcome: "PENDING", code: "NOT_DUE", steps: [{ phase: "reservation", status: "worked", stateBefore: "reservation_pending", stateAfter: "reservation_pending" }], writes: { create: 0, capture: 0, record: 0 }, nextActionAt: ww.due + 120000 };
  }]);
  const piReadsBefore = 0; void piReadsBefore;
  const r = await p.run;
  assert.deepEqual([r.outcome, r.code, p.calls(), r.coordinatorInvocations, r.waits], ["PENDING", "PENDING:NOT_DUE", 2, 2, 1], JSON.stringify(r));
  assert.deepEqual([r.continuation.eligible, r.continuation.reason, r.continuation.readmission, r.continuation.waitMs, r.waitedMs], [true, null, "OK", 120000, 120000]);
  assert.equal(r.continuationVersion, 6); assert.deepEqual(r.invocations.map((x) => [x.label, x.outcome, x.writes.create]), [["FIRST", "PENDING", 1], ["CONTINUATION", "PENDING", 0]]);
  assert.deepEqual(r.proofs, ["STRIPE_AT_START", "STRIPE_AT_CONTINUATION"], "a FRESH Stripe proof at the re-admission (not the cached start proof)");
  assert.equal(w.calls.filter((x) => x.includes("/v1/payment_intents/")).length, 2, "two PI reads: start + continuation");
  assert.equal(r.nextActionAt, new Date(w.due + 120000).toISOString(), "the second PENDING reports its own sanitized nextActionAt");
  assert.equal(writesOfFake(w), 0, "no provider write reached the fake exchange");
  // the plan explicitly binds the continuation contract
  const pl = plan(); assert.deepEqual(pl.continuation, { maxCoordinatorInvocations: 2, maxWaits: 1, maxWaitMs: 150000,
    branch: "PENDING:NOT_DUE+reservation_pending+one_settled_create+no_capture_record", readmission: "fresh_durable_facts+same_version+refund_veto+fresh_stripe_proof+final_durable_reread_after_proof+no_active_hold+no_unprocessed_inbox" });
  assert.deepEqual([C.budgets.coordinatorInvocations, C.budgets.maxWaits, C.budgets.maxWaitMs, C.budgets.runMs], [2, 1, 150000, 12 * 60 * 1000]);
});
const writesOfFake = (w) => w.calls.filter((x) => /^(S POST|H POST)/.test(x)).length;
test("H13 C100 re-admission drift / error → STOP CONTINUATION_REFUSED (never a second invocation): version / create identity / rid / next action / early due / live lease / refund evidence / fresh PI mismatch / dispute unknown", async () => {
  for (const [label, during, want] of [
    ["version", (w) => { w.version = 7; }, "STATE_OR_VERSION_DRIFT"], ["state", (w) => { w.status = "reservation_confirmed"; }, "STATE_OR_VERSION_DRIFT"],
    ["create identity", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { result_ref: "71999901", attempts: 2 }); }, "OPS_DRIFT"],
    ["rid", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { result_ref: "71999909" }); }, null],
    ["new write row", (w) => { w.ops.push(opRow("stripe.capture_payment_intent", { state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_amount: AMT, payload_key: `cap:${IID}:${PI}` })); }, "OPS_DRIFT"],
    ["next action", (w) => { w.work[0].next_action_at = new Date(w.due + 5000); }, "NEXT_ACTION_DRIFT"],
    ["live work lease", (w) => { w.work[0].work_lease_until = new Date(w.due + 60000); w.work[0].work_worker_id = "x"; }, "WORK_LEASE_LIVE"],
    ["refund evidence", (w) => { w.evidence = [{ kind: "payment_intent", external_ref: PI, observed: { amountRefundedMinor: 1 } }]; }, "PAYMENT_REFUND_OBSERVED"],
    ["fresh PI mismatch", (w) => { w.pi = piObj({ amount: AMT + 1 }); }, "FRESH_PROOF_PAYMENT_INTENT_IDENTITY"],
    ["fresh PI canceled", (w) => { w.pi = piObj({ status: "canceled" }); }, "FRESH_PROOF_NOT_REQUIRES_CAPTURE"],
    ["dispute unknown", (w) => { w.pi = piObj({}, { disputed: null }); }, "FRESH_PROOF_CHARGE_DISPUTE_UNKNOWN"]]) {
    const w = pworld(); let second = 0;
    const p = pcore(w, [async (ww) => { const x = pending1(ww); setImmediate(() => during(ww)); return x; }, () => { second += 1; return {}; }]);
    // mutate AFTER the first readback (eligibility) but BEFORE the re-admission: run the mutation inside the wait
    const r = await p.run;
    assert.equal(second, 0, `${label}: no second invocation`); assert.equal(r.outcome, "STOP", `${label}: ${JSON.stringify(r)}`);
    if (want) assert.equal(r.code, `CONTINUATION_REFUSED:${want}`, label); else assert.match(r.code, /^CONTINUATION_REFUSED:/, label);
    assert.equal(writesOfFake(w), 0, label);
  }
  { const w = pworld(); const p = pcore(w, [pending1, () => { throw new Error("must not run"); }], { freezeClock: true }); const r = await p.run;
    assert.deepEqual([r.outcome, r.code, p.calls()], ["STOP", "CONTINUATION_REFUSED:NOT_DUE_AFTER_WAIT", 1], "a wait that ended before the due time never resumes"); }
});
test("H14 C100 the wait is inside the ONE seal: deadline / abort / lock-session error during the wait → STOP within 40 ms, the connection(s) destroyed, NO further DB / provider activity, no second invocation; a late wait completion is discarded", async () => {
  for (const kind of ["deadline", "abort", "lockError"]) {
    const w = pworld(); const ac = new AbortController(); let lockErr = null; let dbAfter = 0; let sealedAt = null;
    const lockFactory = async () => { const lk = fpool(w).lock(); return { query: (a, b) => { if (sealedAt !== null) dbAfter += 1; return lk.query(a, b); }, release: lk.release, on: (ev, fn) => { if (ev === "error") lockErr = fn; } }; };
    const basePool = fpool(w); const pool = { query: basePool.query, connect: async () => { const cl = await basePool.connect(); return { ...cl, query: (a, b) => { if (sealedAt !== null) dbAfter += 1; return cl.query(a, b); } }; } };
    const p = pcore(w, [pending1, () => { throw new Error("no second invocation"); }], { holdWait: true, core: { pool, lockClientFactory: lockFactory }, extra: { runSignal: ac.signal } });
    for (let i = 0; i < 100 && p.T.waits.length === 0; i++) await tick(2);
    assert.equal(p.T.waits.length, 1, `${kind}: waiting`);
    const callsAtSeal = w.calls.length; sealedAt = Date.now();
    if (kind === "deadline") p.T.fire("deadline"); else if (kind === "abort") ac.abort(); else lockErr(new Error("terminated"));
    const r = await race40(p.run);
    assert.notEqual(r, "STILL_PENDING_AFTER_DEADLINE", kind);
    assert.deepEqual([r.outcome, r.sealed, r.waits, p.calls()], ["STOP", true, 1, 1], `${kind}: ${JSON.stringify(r)}`);
    assert.match(r.code, kind === "deadline" ? /STOP_DEADLINE/ : kind === "abort" ? /STOP_ABORTED/ : /STOP_LOCK_SESSION_ERROR/, kind);
    p.T.waits[0].fn(); await tick(20);                                                                 // the LATE wait completion
    assert.equal(w.calls.length, callsAtSeal, `${kind}: no provider call after the seal`); assert.equal(dbAfter, 0, `${kind}: no DB statement after the seal`);
    assert.equal(p.calls(), 1, `${kind}: the late completion resumes nothing`);
  }
});

/** C101: a Stripe exchange whose CONTINUATION PI read (the 2nd GET /payment_intents) awaits the original valid reply, THEN runs `mut(w)` before resolving */
const proofMutating = (w, mut) => { const base = fexchanges(w); let piGets = 0;
  return { hostaway: base.hostaway, stripe: async (req) => { const isPi = req.method === "GET" && req.url.includes("/v1/payment_intents/"); if (isPi) piGets += 1;
    const out = await base.stripe(req); if (isPi && piGets === 2) { await mut(w); w.mutatedDuringProof = true; } return out; } }; };
test("H15 C101-F1 facts changed DURING the fresh continuation proof (after the valid PI reply) → the FINAL durable re-read refuses: no second invocation, zero provider writes; the healthy control continues and binds from the final read", async () => {
  for (const [label, mut, want] of [
    ["version 6→7", (w) => { w.version = 7; }, "FINAL_STATE_OR_VERSION_DRIFT"],
    ["open case 0→1", (w) => { w.cases = 1; }, "FINAL_FACTS_OPEN_CASE"],
    ["refund evidence", (w) => { w.evidence = [{ kind: "payment_intent", external_ref: PI, observed: { amountRefundedMinor: 1 } }]; }, "FINAL_PAYMENT_REFUND_OBSERVED"],
    ["create identity", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { result_ref: "71999901", attempts: 2 }); }, "FINAL_OPS_DRIFT"],
    ["rid drift", (w) => { w.ops[0] = opRow("hostaway.create_reservation", { result_ref: "71999909" }); }, null],
    ["capture key binding drift", (w) => { w.ops.push(opRow("stripe.capture_payment_intent", { state: "pending", attempts: 0, dispatched: false, payload_pi: PI, payload_amount: AMT, payload_key: `cap:${IID}:pi_other` })); }, null],
    ["next action drift", (w) => { w.work[0].next_action_at = new Date(w.due + 5000); }, "FINAL_NEXT_ACTION_DRIFT"],
    ["live work lease", (w) => { w.work[0].work_worker_id = "x"; w.work[0].work_lease_until = new Date(w.due + 60000); }, "FINAL_WORK_LEASE_LIVE"],
    ["state", (w) => { w.status = "reservation_confirmed"; }, "FINAL_STATE_OR_VERSION_DRIFT"]]) {
    const w = pworld(); let second = 0;
    const p = pcore(w, [pending1, () => { second += 1; return {}; }], { extra: { exchanges: proofMutating(w, mut) } });
    const r = await p.run;
    assert.equal(w.mutatedDuringProof, true, `${label}: the mutation ran inside the continuation proof`);
    assert.deepEqual([r.outcome, second, p.calls(), r.coordinatorInvocations, writesOfFake(w)], ["STOP", 0, 1, 1, 0], `${label}: ${JSON.stringify(r)}`);
    if (want) assert.equal(r.code, `CONTINUATION_REFUSED:${want}`, label); else assert.match(r.code, /^CONTINUATION_REFUSED:FINAL_/, `${label}: ${r.code}`);
    assert.notEqual(r.continuation.readmission, "OK", label); assert.deepEqual(r.proofs, ["STRIPE_AT_START", "STRIPE_AT_CONTINUATION"], `${label}: no extra provider await`);
  }
  { const w = pworld(); let seenRid = null;                                                          // healthy control: no mutation → continues, bound to the FINAL rid
    const p = pcore(w, [pending1, (ww, o) => { seenRid = typeof o.phases.reservation.executors.createReservation; return { outcome: "PENDING", code: "NOT_DUE", steps: [], writes: { create: 0, capture: 0, record: 0 }, nextActionAt: ww.due + 120000 }; }],
      { extra: { exchanges: proofMutating(w, () => {}) } });
    const r = await p.run;
    assert.deepEqual([r.outcome, r.continuation.readmission, p.calls(), seenRid, writesOfFake(w)], ["PENDING", "OK", 2, "function", 0], JSON.stringify(r)); }
});
test("H16 C101-F1 the FINAL re-read itself: throw → STOP FINAL_READ_FAILED; hang → its local statement bound SEALS (STOP, connection destroyed); a deadline seal during it → STOP; never a second invocation, zero provider writes", async () => {
  for (const kind of ["throw", "hang", "deadline"]) {
    const w = pworld(); let second = 0; let armed = false; const st = { destroyed: 0, hung: null };
    const base = fpool(w);
    const wrapQ = (sql, params) => { if (armed && /e7hpl:row\*/.test(String(sql))) { armed = false;
        if (kind === "throw") return Promise.reject(new Error("final read failed"));
        st.hung = deferred(); return st.hung.p; }
      return base.query(sql, params); };
    const pool = { query: wrapQ, connect: async () => ({ query: wrapQ, release: (x) => { if (x === true) st.destroyed += 1; }, on() {} }) };
    const p = pcore(w, [pending1, () => { second += 1; return {}; }], { core: { pool }, extra: { exchanges: proofMutating(w, () => { armed = true; }) } });
    if (kind !== "throw") { for (let i = 0; i < 200 && !st.hung; i++) await tick(2); assert.ok(st.hung, `${kind}: the final read is in flight`); p.T.fire(kind === "hang" ? "db" : "deadline"); }
    const r = await race40(p.run);
    assert.notEqual(r, "STILL_PENDING_AFTER_DEADLINE", kind);
    assert.deepEqual([r.outcome, second, p.calls(), writesOfFake(w)], ["STOP", 0, 1, 0], `${kind}: ${JSON.stringify(r)}`);
    if (kind === "throw") assert.equal(r.code, "CONTINUATION_REFUSED:FINAL_READ_FAILED");
    else { assert.equal(r.sealed, true, kind); assert.match(r.code, kind === "hang" ? /STOP_DB_STATEMENT_TIMEOUT/ : /STOP_DEADLINE/, kind); assert.ok(st.destroyed >= 1, `${kind}: connection destroyed`);
      st.hung.res({ rows: [] }); await tick(10); assert.equal(second, 0, `${kind}: the late completion resumes nothing`); }
  }
});
test("H17 C101-F2 an active recording hold / any unprocessed conflict-inbox row (with ZERO open cases) prevents the wait and the continuation: present after the first invocation → no wait (PENDING, reason); inserted DURING the wait or DURING the fresh proof → CONTINUATION_REFUSED; gate read failure → no continuation; nothing is processed / released", async () => {
  for (const [label, mut, reason] of [["hold", (w) => { w.holds = 1; }, "RECORDING_HOLD_ACTIVE"], ["inbox", (w) => { w.inbox = 1; }, "CONFLICT_INBOX_UNPROCESSED"],
    ["gate read throws", (w) => { w.holdsQuery = () => { throw new Error("no table"); }; }, "GATES_READ_FAILED"]]) {
    const w = pworld(); const p = pcore(w, [(ww) => { mut(ww); return pending1(ww); }]); const r = await p.run;
    assert.equal(w.cases, 0, label);
    assert.deepEqual([r.outcome, r.code, p.calls(), r.waits, p.T.waits.length, r.continuation.eligible, r.continuation.reason], ["PENDING", "PENDING:NOT_DUE", 1, 0, 0, false, reason], `${label}: ${JSON.stringify(r)}`);
  }
  for (const [label, mut, want] of [["hold", (w) => { w.holds = 1; }, "RECORDING_HOLD_ACTIVE"], ["inbox", (w) => { w.inbox = 2; }, "CONFLICT_INBOX_UNPROCESSED"]]) {
    { const w = pworld(); let second = 0;                                                             // during the wait
      const p = pcore(w, [async (ww) => { const x = pending1(ww); setImmediate(() => mut(ww)); return x; }, () => { second += 1; return {}; }]); const r = await p.run;
      assert.deepEqual([r.outcome, r.code, second, r.waits, writesOfFake(w)], ["STOP", `CONTINUATION_REFUSED:${want}`, 0, 1, 0], `wait ${label}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.proofs, ["STRIPE_AT_START"], `wait ${label}: refused BEFORE the fresh provider proof`); }
    { const w = pworld(); let second = 0;                                                             // during the fresh proof
      const p = pcore(w, [pending1, () => { second += 1; return {}; }], { extra: { exchanges: proofMutating(w, mut) } }); const r = await p.run;
      assert.deepEqual([r.outcome, r.code, second, writesOfFake(w)], ["STOP", `CONTINUATION_REFUSED:FINAL_${want}`, 0, 0], `proof ${label}: ${JSON.stringify(r)}`); }
  }
  assert.match(E.QUERIES.holds, /^\/\*e7hpl:holds\*\/ SELECT count\(\*\)::int AS n FROM booking\.recording_holds WHERE intent_id = \$1 AND released_at IS NULL$/);
  assert.match(E.QUERIES.inbox, /^\/\*e7hpl:inbox\*\/ SELECT count\(\*\)::int AS n FROM booking\.recording_conflict_inbox WHERE intent_id = \$1 AND processed_at IS NULL$/);
  for (const k of Object.keys(E.QUERIES)) assert.match(E.QUERIES[k], /^\/\*e7hpl:\w+\*\/ SELECT /, `${k}: pure SELECT`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN INTEGRATION (E7_HPL_DB_TESTS=1; tooling with its pinned pg; PG_BIN): the REAL merged coordinator + workers + repo + operations + transports +
// executor adapters on a disposable PostgreSQL. FAKE exchanges ONLY; fixtures through the accepted APIs. The hosted preflight child never sets it.
if (process.env.E7_HPL_DB_TESTS === "1") {
  const [{ startMigratedDatabase }, F, R, O, pgMod, SP, DP, PA, AD] = await Promise.all([tool("test/db/harness.mjs"), tool("test/db/fixtures.mjs"), tool("lib/booking-db/repo.js"),
    tool("lib/booking-db/operations.js"), import(pathToFileURL(join(TOOLING, "node_modules/pg/lib/index.js")).href), tool("lib/checkout/server-pricer.js"), tool("lib/direct-policy.js"),
    tool("lib/public-api.js"), tool("db/lib/admin.js")]);
  const pg = pgMod.default ?? pgMod;
  const db = await startMigratedDatabase();
  after(async () => { await db.close(); });
  const LIST = 606998; const SEC = 1000; const MIN = 60 * SEC; const DAY = 24 * 60 * MIN;
  const CO = await tool("lib/booking-db/test-pipeline-coordinator.js");
  const realTooling = { ...pureTooling, refundObservationRefusal: CO.refundObservationRefusal, runTestPipelineCoordinator: CO.runTestPipelineCoordinator, loadIntent: R.loadIntent };
  test("P0 the REAL coordinator: its static gate admits the options the runner hands it (captured in H8); its refund veto agrees with the main C16 function the fake suites use; TEST listing / write budget", () => {
    assert.ok(CAPTURED.opts, "H8 ran first"); const g = CO.coordinatorGate(CAPTURED.opts); assert.deepEqual(g, { ok: true, maxSteps: 6 });
    assert.equal(CO.TEST_LISTING_ID, C.listingId); assert.deepEqual(CO.WRITE_BUDGET, { create: 1, capture: 1, record: 1 });
    const ev = (observed, extra = {}) => [{ kind: "payment_intent", external_ref: "pi_X", observed, ...extra }];
    for (const rows of [[], ev({ amountRefundedMinor: 0 }), ev({ amountRefundedMinor: 5 }), ev({ refunded: true }), ev({ refunded: "x" }), ev({ amountRefundedMinor: -1 }), ev({ amountRefundedMinor: 5 }, { external_ref: "pi_Y" }),
      ev({ amountRefundedMinor: 5 }, { kind: "charge" }), ev(null), [...ev({ amountRefundedMinor: 0 }), ...ev({ refunded: true })]]) {
      assert.equal(CO.refundObservationRefusal(rows, "pi_X"), RECRUN.refundObservationRefusal(rows, "pi_X"), JSON.stringify(rows)); }
  });
  const ENVP = { VERCEL_ENV: "development", MV_E7_RESERVATION_WORKER: "enabled" };
  const NIGHTLY = 140; const POLICY = DP.readDirectPolicyFromEnv(ENVP).policy;
  const days = (from, to) => { const out = []; for (let d = from; d <= to; d = F.addDays(d, 1)) out.push({ date: d, status: "available", isAvailable: 1, minimumStay: 1, maximumStay: 90, closedOnArrival: 0, closedOnDeparture: 0 }); return out; };
  const pricing = {
    get: async (path, opts = {}) => { const m = /^\/listings\/(\d+)(\/calendar)?$/.exec(path); if (!m[2]) return { status: 200, json: { result: { id: Number(m[1]), currencyCode: "USD", personCapacity: 4, minNights: 1, maxNights: 90 } } };
      return { status: 200, json: { result: days(opts.query.startDate, opts.query.endDate) } }; },
    post: async (path, body) => { const n = Math.round((Date.parse(body.endingDate) - Date.parse(body.startingDate)) / DAY);
      return { status: 200, json: { status: "success", result: { totalPrice: NIGHTLY * n, components: [{ id: 1, type: "accommodation", name: "baseRate", title: "Base rate", quantity: 1, value: NIGHTLY, total: NIGHTLY * n, isIncludedInTotalPrice: 1, isMandatory: 1, isOverriddenByUser: 0, isDeleted: 0, units: n }] } } }; }
  };
  let lane = 0;
  /** LABELLED COPY (adapted) of the accepted coordinator suite's `authorizedBooking`: a fresh payment_authorized USD intent on 606998, created AFTER the
   *  historical floor (base = now − 20 min), priced by the ACCEPTED server pricer against the SAME fake pricing the worker re-checks */
  async function authorizedBooking() {
    lane += 1;
    const stay = { listingId: LIST, from: F.addDays("2027-04-01", 5 * lane), to: F.addDays("2027-04-01", 5 * lane + 2), guests: 2 };
    const base = Date.now() - 20 * MIN;
    assert.ok(base > Date.parse(C.historicalFloor), "the disposable intent is newer than the historical floor");
    const priced = await SP.priceStay({ request: { ...stay }, listingConfig: { currency: "USD" }, client: pricing, policy: POLICY, today: PA.todayInTimeZone(undefined, new Date(base)), now: base });
    assert.ok(priced.ok, priced.error);
    const intent = await R.createIntentRecord(db.app, { ref: F.nextRef(), accessTokenHash: F.tokenHash(), environment: "test", now: base, ...stay });
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PRICE_CONFIRMED", price: priced.price }, { now: base, actor: "guest" }));
    F.ok(await R.collectGuestDetails(db.app, intent.id, F.GUEST, { now: base + SEC, termsVersion: "terms-2026-10" }));
    const b = F.ok(await R.beginPayStep(db.app, intent.id, { now: base + 2 * SEC }));
    const op = await O.claimNextOperation(db.app, { workerId: "w-pay", now: base + 2 * SEC, intentId: intent.id, opTypes: ["stripe.create_checkout_session"] });
    const sessionId = `cs_test_hpl${lane}`;
    F.ok(await O.completeOperation(db.app, op.id, { workerId: "w-pay", now: base + 2 * SEC, outcome: { status: "succeeded", resultRef: sessionId } }));
    F.ok(await R.recordCheckoutSession(db.app, intent.id, b.attempt.id, { sessionId, expiresAt: base + 30 * MIN, now: base + 2 * SEC }));
    const piId = `pi_test_hpl${String(lane).padStart(4, "0")}`;
    const captureBefore = Math.floor((base + 7 * DAY) / 1000) * 1000;
    F.ok(await R.applyEvent(db.app, intent.id, { type: "PAYMENT_AUTHORIZED", id: `evt_auth_${piId}`, paymentIntentId: piId, sessionId, amountMinor: priced.price.finalTotalMinor,
      currency: "usd", livemode: false, authorizationCreatedAt: base + 3 * SEC, captureBefore }, { now: base + 4 * SEC, actor: "webhook" }));
    const pa = (await db.app.query("SELECT id::text AS id FROM booking.payment_attempts WHERE intent_id = $1 AND status = 'completed'", [intent.id])).rows[0].id;
    const i = await R.loadIntent(db.app, intent.id);
    assert.equal(i.status, "payment_authorized");
    return { id: intent.id, ref: i.ref, stay, piId, attemptId: pa, total: priced.price.finalTotalMinor, base, captureBefore };
  }
  /** fake provider world on the WIRE (requests arrive through the REAL adapters → REAL transports → the runner fence) */
  function pgWorld(bk, o = {}) {
    const w = { calls: [], res: new Map(), charges: [], nextRes: 74000000 + lane * 10, nextCharge: 8800000 + lane * 10, captured: false, refundedAfterCapture: false, piStatus: "requires_capture",
      creates: 0, captures: 0, records: 0, echoCreate: o.echoCreate ?? true, echoGet: o.echoGet ?? true, disputed: false, disputeAbsent: o.disputeAbsent === true };
    const reply = (status, x) => Promise.resolve({ status, contentType: "application/json", bytes: enc(x) });
    w.pi = () => ({ object: "payment_intent", id: bk.piId, livemode: false, status: w.captured ? "succeeded" : w.piStatus, capture_method: "manual", amount: o.piAmount ?? bk.total,
      amount_received: w.captured ? bk.total : 0, amount_capturable: !w.captured && w.piStatus === "requires_capture" ? bk.total : 0, currency: "usd",
      metadata: { mv_intent_id: bk.id, mv_payment_attempt_id: bk.attemptId },
      latest_charge: { object: "charge", id: `ch_test_hpl${lane}`, payment_intent: bk.piId, status: "succeeded", paid: true, captured: w.captured, amount: bk.total,
        amount_captured: w.captured ? bk.total : 0, amount_refunded: w.refundedAfterCapture ? bk.total : 0, refunded: w.refundedAfterCapture,
        ...(w.disputeAbsent ? {} : { disputed: w.disputed }), currency: "usd", livemode: false,
        payment_method_details: { card: { capture_before: bk.captureBefore / 1000 } } } });
    const full = (r, withRef = true) => ({ id: r.id, listingMapId: LIST, channelId: 2000, arrivalDate: bk.stay.from, departureDate: bk.stay.to, totalPrice: bk.total / 100, currency: "USD",
      status: "new", ...(withRef ? { customFieldValues: [{ customFieldId: C.refFieldId, value: bk.ref }] } : {}) });
    w.stripe = async (req) => {
      w.calls.push(`S ${req.method} ${req.url.replace("https://api.stripe.com", "")}`);
      if (req.url.endsWith("/v1/account")) return reply(200, { object: "account", id: C.accountId });
      if (req.method === "POST") {
        assert.equal(req.url, `https://api.stripe.com/v1/payment_intents/${bk.piId}/capture`); assert.equal(req.headers["Idempotency-Key"], `cap:${bk.id}:${bk.piId}`);
        assert.equal(req.body, `amount_to_capture=${bk.total}&expand%5B%5D=latest_charge`, "C1/C2 wire: no final_capture");
        w.captures += 1; w.captured = true;
        if (o.afterCapture) await o.afterCapture(w);
        if (o.captureLost) return Promise.reject(new Error("socket reset"));
        return reply(200, w.pi());
      }
      if (o.disputeOnceCapturedDurably !== undefined && w.captured && w.disputed === false) {
        const st = (await db.owner.query("SELECT state FROM booking.intents WHERE id = $1", [bk.id])).rows[0].state;
        if (st === "payment_captured") w.disputed = o.disputeOnceCapturedDurably;          // a malformed dispute field observed only AFTER the capture step committed
      }
      if (o.refundOnceCapturedDurably && w.captured && !w.refundedAfterCapture) {
        const st = (await db.owner.query("SELECT state FROM booking.intents WHERE id = $1", [bk.id])).rows[0].state;
        if (st === "payment_captured") w.refundedAfterCapture = true;                  // a refund observed only AFTER the accepted capture step committed
      }
      return reply(200, w.pi());
    };
    w.hostaway = async (req) => {
      const p = req.url.replace("https://api.hostaway.com", ""); w.calls.push(`H ${req.method} ${p}`);
      const u = new URL(req.url);
      if (req.method === "GET" && /^\/v1\/listings\/\d+$/.test(p)) return pricing.get(p.slice(3)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && /^\/v1\/listings\/\d+\/calendar$/.test(u.pathname)) return pricing.get(u.pathname.slice(3), { query: Object.fromEntries(u.searchParams) }).then((x) => reply(x.status, x.json));
      if (req.method === "POST" && /priceDetails$/.test(p)) return pricing.post(p.slice(3), JSON.parse(req.body)).then((x) => reply(x.status, x.json));
      if (req.method === "GET" && p.startsWith("/v1/reservations?")) return reply(200, { status: "success", result: u.searchParams.has("afterId") ? [] : [...w.res.values()].map((r) => full(r, w.echoGet)) });
      if (req.method === "POST" && p === "/v1/reservations") {
        const body = JSON.parse(req.body); assert.equal(body.listingMapId, LIST); assert.equal(body.customFieldValues[0].value, bk.ref); assert.ok(!req.body.includes("forceOverbooking"));
        const r = { id: w.nextRes++ }; w.res.set(r.id, r); w.creates += 1;
        if (o.afterCreate) o.afterCreate(w);
        if (o.createLost) return Promise.reject(new Error("socket reset"));
        return reply(201, { status: "success", result: full(r, w.echoCreate) });
      }
      if (req.method === "GET" && p.startsWith("/v1/guestPayments/charges?")) {
        const rid = u.searchParams.get("reservationIds");
        const rows = w.charges.filter((x) => String(x.reservationId) === rid).map((x) => ({ ...x }));
        return reply(200, { status: "success", result: rows, count: rows.length, limit: 500, offset: null });
      }
      if (req.method === "POST" && /^\/v1\/guestPayments\/charges\/\d+$/.test(p)) {
        const rid = Number(p.split("/").pop()); const body = JSON.parse(req.body);
        assert.deepEqual(Object.keys(body).sort(), ["amount", "paymentMethod", "scheduledDate", "status", "title"]); assert.equal(body.title, `maraVilla payment mvoch1-${bk.id}`);
        const ch = { id: w.nextCharge++, listingMapId: LIST, reservationId: rid, type: "charge", title: body.title, currency: "USD", paymentMethod: body.paymentMethod, amount: body.amount, status: "paid", paymentProvider: "offline" };
        w.charges.push(ch); w.records += 1;
        if (o.recordLost) return Promise.reject(new Error("socket reset"));
        return reply(201, { status: "success", result: { ...ch } });
      }
      const m = /^\/v1\/reservations\/(\d+)$/.exec(p);
      if (req.method === "GET" && m) { const r = w.res.get(Number(m[1])); return r ? reply(200, { status: "success", result: full(r, w.echoGet) }) : reply(404, { status: "fail" }); }
      return reply(404, { status: "fail" });
    };
    return w;
  }
  const version = async (id) => (await R.loadIntent(db.app, id)).version;
  const pgRun = async (bk, w, extra = {}, over = {}) => {
    const clk = extra.clk ?? { t: bk.base + 10 * SEC };
    const p = E.buildPlan(C, { approvalRef: "SYNTHETIC-hpl-pg", intentId: bk.id, ref: bk.ref, expectedVersion: await version(bk.id), notBefore: new Date(bk.base - MIN).toISOString(),
      paymentIntentId: bk.piId, amountMinor: bk.total, currency: "USD", sourceDigest: "0".repeat(64), ...over }).plan;
    const { clk: _c, ...rest } = extra;
    return E.runPipelineCore({ plan: p, pool: db.app, tooling: realTooling, exchanges: { stripe: w.stripe, hostaway: w.hostaway },
      credentials: { stripe: () => "sk_test_Fake1", hostaway: () => "synthetic-hostaway-token" }, runId: "pg-run-00000001", clock: () => clk.t, recordingClock: Date.now, ...rest });
  };
  const snap = async (id) => ({ st: (await db.owner.query("SELECT state, version, hostaway_reservation_id::text AS rid, offline_charge_id::text AS och FROM booking.intents WHERE id = $1", [id])).rows[0],
    ops: (await db.owner.query("SELECT op_type, state, attempts, (dispatched_at IS NOT NULL) AS d FROM booking.external_operations WHERE intent_id = $1 ORDER BY op_type, created_at", [id])).rows,
    claim: (await db.owner.query("SELECT (released_at IS NOT NULL) AS released FROM booking.inventory_claims WHERE intent_id = $1", [id])).rows,
    cases: Number((await db.owner.query("SELECT count(*)::int AS n FROM booking.reconciliation_cases WHERE intent_id = $1 AND status = 'open'", [id])).rows[0].n),
    locks: Number((await db.owner.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n) });
  const writesOf = (w) => w.calls.filter((x) => /^(S POST|H POST(?! \/v1\/listings)|H PUT|H DELETE)/.test(x));
  const opsOf = (s, t) => s.ops.filter((x) => x.op_type === t).map((x) => [x.state, x.attempts, x.d]);

  test("P1 PG (REAL coordinator + workers + adapters + transports; FAKE exchanges): echoed success — ONE invocation drives authorized → confirmed; EXACTLY 1 create / 1 capture / 1 offline-charge POST; fresh Stripe proofs at start, before capture and before recording + the echo proof; durable postcheck verified; notify queued undispatched; claim held; lock released; a SECOND dispatch refuses read-only with zero sends", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk);
    const r = await pgRun(bk, w);
    assert.deepEqual([r.outcome, r.code, r.verifiedCompletion, r.possiblyEffected, r.coordinatorInvocations], ["CONFIRMED_VERIFIED", "CONFIRMED", true, false, 1], JSON.stringify(r));
    assert.deepEqual(r.coordinator.steps.map((s) => [s.phase, s.stateBefore, s.stateAfter]), [["reservation", "payment_authorized", "reservation_pending"],
      ["reservation", "reservation_pending", "reservation_confirmed"], ["capture", "reservation_confirmed", "payment_captured"], ["recording", "payment_captured", "confirmed"]]);
    assert.deepEqual([r.sends, r.replies, r.coordinator.writes], [{ create: 1, capture: 1, record: 1 }, { create: "REPLIED", capture: "REPLIED", record: "REPLIED" }, { create: 1, capture: 1, record: 1 }]);
    assert.deepEqual(r.proofs, ["STRIPE_AT_START", "STRIPE_BEFORE_CAPTURE", "STRIPE_BEFORE_RECORDING", "ECHO_BEFORE_RECORDING"]);
    assert.deepEqual(writesOf(w).map((x) => x.replace(/\d+$/, "N")), ["H POST /v1/reservations", `S POST /v1/payment_intents/${bk.piId}/capture`, "H POST /v1/guestPayments/charges/N"]);
    assert.deepEqual([w.creates, w.captures, w.records], [1, 1, 1]);
    const s = await snap(bk.id);
    assert.deepEqual([s.st.state, s.st.och, r.offlineChargeId, s.claim.length, s.claim[0].released, s.cases, s.locks, r.lock], ["confirmed", String(w.charges[0].id), String(w.charges[0].id), 1, false, 0, 0, "released"]);
    for (const t of ["hostaway.create_reservation", "stripe.capture_payment_intent", "hostaway.record_offline_charge"]) assert.deepEqual(opsOf(s, t), [["succeeded", 1, true]], t);
    for (const o of s.ops.filter((x) => x.op_type === "guest.notify")) assert.equal(o.d, false, "the custom notify stays undispatched");
    for (const t of ["stripe.void_payment_intent", "hostaway.cancel_reservation"]) assert.equal(s.ops.filter((x) => x.op_type === t).length, 0, t);
    console.log(`# P1: steps=${r.coordinator.steps.length} dbQueries=${r.dbQueries} exchanges=${r.exchanges} pi=${r.piReads} acct=${r.accountReads} hx=${r.hostawayReads} lookups=${r.lookupPages} lists=${r.chargeLists} pricing=${r.pricingCalls}`);
    assert.ok(r.dbQueries <= C.budgets.dbQueries && r.exchanges <= C.budgets.exchanges);
    const w2 = pgWorld(bk); const r2 = await pgRun(bk, w2);
    assert.deepEqual([r2.outcome, r2.code, w2.calls.length, r2.coordinatorInvocations], ["STOP", "ADMISSION_REFUSED:STATE_NOT_IN_PIPELINE", 0, 0]);
  });

  /** C100 fake wait seam: "wait" advances the fake business clock by its ms (after an optional async `during` hook) and fires; deadline timers are
   *  captured (`deadline()` fires the run deadline); everything else is real. No real 150 s sleep. */
  const fastWait = (clk, o = {}) => { const sx = { deadline: null, waits: 0 };
    sx.timer = (fn, ms, kind) => {
      if (kind === "deadline") { const h = { fn, k: "deadline" }; sx.deadline = () => fn(); return h; }
      if (kind === "wait") { sx.waits += 1; const h = { k: "wait", cleared: false }; (async () => { if (o.during) await o.during(sx); await new Promise((r2) => setImmediate(r2)); if (!h.cleared && !o.hold) { clk.t += ms; fn(); } })(); return h; }
      return setTimeout(fn, ms);
    };
    sx.clearTimer = (h) => { if (h && typeof h === "object" && h.k) h.cleared = true; else clearTimeout(h); };
    return sx; };
  test("P2 PG C100 non-echo in ONE run (REAL coordinator + workers): create reply lacks the ref → PENDING NOT_DUE → ONE bounded wait (fake clock) → fresh re-admission → second invocation READS the existing create only (create 0) → CONFIRMED_VERIFIED; cumulative 1 / 1 / 1; per-invocation + cumulative results reported", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
    const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.deepEqual([r.outcome, r.code, r.verifiedCompletion, r.coordinatorInvocations, r.waits, fw.waits], ["CONFIRMED_VERIFIED", "CONFIRMED", true, 2, 1, 1], JSON.stringify(r));
    assert.deepEqual(r.invocations.map((x) => [x.label, x.outcome, x.code, x.writes]), [["FIRST", "PENDING", "NOT_DUE", { create: 1, capture: 0, record: 0 }],
      ["CONTINUATION", "CONFIRMED", "CONFIRMED", { create: 0, capture: 1, record: 1 }]]);
    assert.deepEqual([r.sends, w.creates, w.captures, w.records], [{ create: 1, capture: 1, record: 1 }, 1, 1, 1], "cumulative exactly one of each");
    assert.deepEqual([r.continuation.eligible, r.continuation.readmission], [true, "OK"]); assert.ok(r.waitedMs > 0 && r.waitedMs <= 150000, String(r.waitedMs));
    assert.deepEqual(r.proofs, ["STRIPE_AT_START", "STRIPE_AT_CONTINUATION", "STRIPE_BEFORE_CAPTURE", "STRIPE_BEFORE_RECORDING", "ECHO_BEFORE_RECORDING"]);
    const s = await snap(bk.id); assert.deepEqual([s.st.state, s.locks, r.lock], ["confirmed", 0, "released"]);
    console.log(`# P2 (C100): steps=${r.invocations.map((x) => x.steps.length).join("+")} dbQueries=${r.dbQueries} exchanges=${r.exchanges} pi=${r.piReads} waitedMs=${r.waitedMs}`);
  });
  test("P2b PG no run reserve after the first invocation → existing PENDING NOT_DUE (no wait); a FUTURE separately dispatched attempt still continues read-only (create 0) to CONFIRMED", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
    const now = () => (w.creates >= 1 ? Date.now() + C.budgets.runMs - C.budgets.teardownMs - 100000 : Date.now());
    const r = await pgRun(bk, w, { clk, now, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.deepEqual([r.outcome, r.code, r.waits, r.coordinatorInvocations, r.continuation && r.continuation.reason], ["PENDING", "PENDING:NOT_DUE", 0, 1, "NO_RUN_RESERVE"], JSON.stringify(r));
    assert.deepEqual([r.sends, w.captures, w.records, r.possiblyEffected, r.verifiedCompletion], [{ create: 1, capture: 0, record: 0 }, 0, 0, false, false]);
    clk.t = Date.parse(r.nextActionAt) + SEC;
    const r2 = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.deepEqual([r2.outcome, r2.sends, r2.coordinatorInvocations, r2.waits], ["CONFIRMED_VERIFIED", { create: 0, capture: 1, record: 1 }, 1, 0], JSON.stringify(r2));
    assert.deepEqual([w.creates, w.captures, w.records], [1, 1, 1]);
  });
  test("P12 PG C100 never waits after a first write UNKNOWN (lost create reply): STOP, ONE invocation, no wait, no capture", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { createLost: true }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
    const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.deepEqual([r.outcome, r.coordinatorInvocations, r.waits, fw.waits, r.sends.create, r.replies.create, w.captures, r.possiblyEffected], ["STOP", 1, 0, 0, 1, "UNKNOWN", 0, true], JSON.stringify(r));
  });
  test("P13 PG C100 re-admission STOPs on facts changed DURING the wait: a stored refund observation / a canceled PI → CONTINUATION_REFUSED, no second invocation, no capture / record", async () => {
    for (const [label, want] of [["refund", "PAYMENT_REFUND_OBSERVED"], ["pi canceled", "FRESH_PROOF_NOT_REQUIRES_CAPTURE"]]) {
      const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC };
      const fw = fastWait(clk, { during: async () => { if (label === "refund") await refundObs(bk, { amountRefundedMinor: 100 }); else w.piStatus = "canceled"; } });
      const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
      assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, r.waits, w.captures, w.records, r.sends.create], ["STOP", `CONTINUATION_REFUSED:${want}`, 1, 1, 0, 0, 1], `${label}: ${JSON.stringify(r)}`);
      assert.equal((await snap(bk.id)).locks, 0);
    }
  });
  test("P14 PG C100 the run deadline DURING the wait seals: STOP_DEADLINE, no second invocation, no capture / record, lock session destroyed (advisory lock released)", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC };
    const fw = fastWait(clk, { hold: true });
    const run = pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
    for (let i = 0; i < 500 && fw.waits === 0; i++) await tick(10);
    assert.equal(fw.waits, 1, "waiting");
    fw.deadline();
    const rr = await race40(run);
    assert.notEqual(rr, "STILL_PENDING_AFTER_DEADLINE", "the seal ends the run promptly");
    assert.deepEqual([rr.outcome, rr.code, rr.sealed, rr.coordinatorInvocations, rr.waits, w.captures, w.records], ["STOP", "STOP_DEADLINE", true, 1, 1, 0, 0], JSON.stringify(rr));
    for (let i = 0; i < 50; i++) { if ((await snap(bk.id)).locks === 0) break; await tick(20); }
    assert.equal((await snap(bk.id)).locks, 0);
  });
  test("P15 PG C100 the reservation still not echoed after the wait: the continuation never creates and never runs a third invocation / wait (the scripted second-PENDING exit is H12); cumulative create 1, capture / record 0", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false, echoGet: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
    const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.equal(fw.waits, r.waits); assert.ok(r.coordinatorInvocations <= 2 && r.waits <= 1, JSON.stringify(r));
    assert.deepEqual([w.creates, w.captures, w.records, r.verifiedCompletion], [1, 0, 0, false], JSON.stringify(r));
    assert.ok(r.outcome === "PENDING" || r.outcome === "STOP", r.outcome);              // the REAL worker may settle the unechoed read either way; never a 3rd invocation
    if (r.coordinatorInvocations === 2) assert.equal(r.invocations[1].writes.create, 0, "the continuation never creates");
    console.log(`# P15: outcome=${r.outcome} code=${r.code} invocations=${r.coordinatorInvocations} waits=${r.waits} cont=${JSON.stringify(r.continuation)}`);
  });
  test("P16 PG C100 late fault after the continuation (durable readback disagrees) → STOP POSTCHECK_MISMATCH, never success, possiblyEffected", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
    const tamper = (res, sql) => (/e7hpl:row/.test(String(sql)) && res.rows[0] && res.rows[0].state === "confirmed" ? { ...res, rows: [{ ...res.rows[0], och: "999" }] } : res);
    const pool = { query: async (sql, params) => tamper(await db.app.query(sql, params), sql),
      connect: async () => { const cl = await db.app.connect(); return { query: async (sql, params) => tamper(await cl.query(sql, params), sql), release: (x) => cl.release(x), on: (...a) => cl.on(...a), removeListener: (...a) => cl.removeListener(...a) }; } };
    const r = await pgRun(bk, w, { clk, pool, timer: fw.timer, clearTimer: fw.clearTimer });
    assert.deepEqual([r.outcome, r.code, r.verifiedCompletion, r.possiblyEffected, r.coordinatorInvocations, r.waits], ["STOP", "POSTCHECK_MISMATCH:OFFLINE_CHARGE_NOT_LINKED", false, true, 2, 1], JSON.stringify(r));
  });

  test("P3 PG lost capture reply (applied, reply lost) → STOP, ONE capture POST, possiblyEffected, NO record POST; the accepted worker settles capture_unknown; a later dispatch refuses read-only (no second capture)", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { captureLost: true });
    const r = await pgRun(bk, w);
    assert.deepEqual([r.outcome, r.sends.capture, r.replies.capture, r.sends.record, w.captures, w.records, r.possiblyEffected, r.verifiedCompletion], ["STOP", 1, "UNKNOWN", 0, 1, 0, true, false], JSON.stringify(r));
    assert.match(r.code, /^COORDINATOR_STOP:/);
    const s = await snap(bk.id); assert.equal(s.st.state, "capture_unknown"); assert.deepEqual(opsOf(s, "stripe.capture_payment_intent"), [["outcome_unknown", 1, true]]); assert.equal(s.locks, 0);
    const w2 = pgWorld(bk); const r2 = await pgRun(bk, w2);
    assert.deepEqual([r2.code, w2.calls.length], ["ADMISSION_REFUSED:STATE_NOT_IN_PIPELINE", 0]);
  });

  test("P4 PG lost record reply (applied, reply lost) → STOP after ONE offline-charge POST, possiblyEffected; never a second POST; a later dispatch refuses read-only", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk, { recordLost: true });
    const r = await pgRun(bk, w);
    assert.deepEqual([r.outcome, r.sends.record, r.replies.record, w.records, r.possiblyEffected, r.verifiedCompletion], ["STOP", 1, "UNKNOWN", 1, true, false], JSON.stringify(r));
    const s = await snap(bk.id); assert.notEqual(s.st.state, "confirmed"); assert.equal(s.locks, 0);
    assert.ok(opsOf(s, "hostaway.record_offline_charge").every(([st, , d]) => d === true && st !== "succeeded"), JSON.stringify(s.ops));
    const w2 = pgWorld(bk); const r2 = await pgRun(bk, w2);
    assert.equal(r2.outcome, "STOP"); assert.equal(writesOf(w2).length, 0, JSON.stringify(r2)); assert.equal(w2.records, 0);
  });

  const refundObs = async (bk, observed) => F.ok(await AD.adminRecordEvidence(db.reconciler, { intentId: bk.id, kind: "payment_intent", externalRef: bk.piId, status: "succeeded",
    observed: { amountMinor: bk.total, currency: "USD", amountReceivedMinor: bk.total, amountCapturableMinor: 0, captured: true, ...observed },
    observedAt: new Date(), attestedBy: "owner", reference: "C90 synthetic stored refund observation" }));
  // C101: real disposable-DB fixtures for the continuation gates + the post-proof final re-read
  const offlineEvidence = async (bk) => F.ok(await AD.adminRecordEvidence(db.reconciler, { intentId: bk.id, kind: "hostaway_offline_charges", externalRef: "74000001", status: "listed",
    observed: { matchingChargeCount: 0, matchingChargeIds: [] }, observedAt: new Date(), attestedBy: "owner", reference: "C101 synthetic offline-charge evidence (enqueues one unprocessed inbox row)" }));
  /** a schema-INVALID active hold, written with triggers / FKs bypassed: a VALID active hold needs an OPEN OFFLINE_CHARGE_HOLD_* case and a record op, which
   *  this branch's other gates already refuse; this row isolates the hold gate (zero open cases, no record op) */
  const bypassHold = async (bk) => { const cl = await db.owner.connect();
    try { await cl.query("BEGIN"); await cl.query("SET LOCAL session_replication_role = replica");
      await cl.query(`INSERT INTO booking.recording_holds (id, operation_id, intent_id, reason, case_id, op_state_at_hold, op_key_at_hold, intent_state_at_hold, intent_version_at_hold, created_at, created_by)
        VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'ATTEMPT_GT1', gen_random_uuid(), 'pending', 'och:x', 'reservation_pending', 0, now(), 'c101-test')`, [bk.id]);
      await cl.query("COMMIT"); } catch (e) { await cl.query("ROLLBACK"); throw e; } finally { cl.release(); } };
  const gateCounts = async (bk) => ({ holds: Number((await db.app.query(E.QUERIES.holds, [bk.id])).rows[0].n), inbox: Number((await db.app.query(E.QUERIES.inbox, [bk.id])).rows[0].n) });
  const proofHook = (w, fn) => { const base = w.stripe; let gets = 0;
    w.stripe = async (req) => { const isPi = req.method === "GET" && /\/v1\/payment_intents\/[^/]+(\?|$)/.test(req.url); if (isPi) gets += 1; const out = await base(req); if (isPi && gets === 2) { await fn(); w.hooked = true; } return out; }; return w; };
  test("P17 PG C101-F2 (REAL coordinator + workers, disposable DB): an unprocessed conflict-inbox row (ZERO open cases) or an active hold row → present after the first invocation: no wait; inserted DURING the wait or DURING the fresh proof: CONTINUATION_REFUSED; no second invocation, no capture / record; nothing processed or released", async () => {
    for (const [kind, ins, want] of [["inbox", offlineEvidence, "CONFLICT_INBOX_UNPROCESSED"], ["hold", bypassHold, "RECORDING_HOLD_ACTIVE"]]) {
      { const bk = await authorizedBooking(); await ins(bk); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
        const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
        assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, r.waits, fw.waits, r.continuation && r.continuation.reason, w.creates, w.captures, w.records],
          ["PENDING", "PENDING:NOT_DUE", 1, 0, 0, want, 1, 0, 0], `${kind} before: ${JSON.stringify(r)}`);
        assert.equal((await snap(bk.id)).cases, 0, `${kind}: zero OPEN cases (not equivalent)`); assert.deepEqual(await gateCounts(bk), kind === "inbox" ? { holds: 0, inbox: 1 } : { holds: 1, inbox: 0 }, `${kind}: untouched`); }
      { const bk = await authorizedBooking(); const w = pgWorld(bk, { echoCreate: false }); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk, { during: async () => { await ins(bk); } });
        const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
        assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, r.waits, w.captures, w.records], ["STOP", `CONTINUATION_REFUSED:${want}`, 1, 1, 0, 0], `${kind} wait: ${JSON.stringify(r)}`);
        assert.equal((await snap(bk.id)).locks, 0); }
      { const bk = await authorizedBooking(); const w = proofHook(pgWorld(bk, { echoCreate: false }), () => ins(bk)); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
        const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
        assert.equal(w.hooked, true, `${kind}: inserted inside the continuation proof`);
        assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, w.captures, w.records], ["STOP", `CONTINUATION_REFUSED:FINAL_${want}`, 1, 0, 0], `${kind} proof: ${JSON.stringify(r)}`); }
    }
  });
  test("P18 PG C101-F1 (REAL coordinator + workers): a refund observation stored DURING the fresh continuation proof (after its valid PI reply) → the FINAL durable re-read refuses: no second invocation, no capture / record; the healthy control (hook, no change) continues to CONFIRMED_VERIFIED", async () => {
    { const bk = await authorizedBooking(); const w = proofHook(pgWorld(bk, { echoCreate: false }), () => refundObs(bk, { amountRefundedMinor: 1 })); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
      const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
      assert.equal(w.hooked, true);
      assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, r.waits, w.captures, w.records], ["STOP", "CONTINUATION_REFUSED:FINAL_PAYMENT_REFUND_OBSERVED", 1, 1, 0, 0], JSON.stringify(r)); }
    { const bk = await authorizedBooking(); const w = proofHook(pgWorld(bk, { echoCreate: false }), async () => {}); const clk = { t: bk.base + 10 * SEC }; const fw = fastWait(clk);
      const r = await pgRun(bk, w, { clk, timer: fw.timer, clearTimer: fw.clearTimer });
      assert.deepEqual([r.outcome, r.code, r.coordinatorInvocations, w.creates, w.captures, w.records], ["CONFIRMED_VERIFIED", "CONFIRMED", 2, 1, 1, 1], JSON.stringify(r)); }
  });
  test("P5 PG stored refund veto: present at admission → refused before the lock, zero provider calls; stored between capture and recording → the coordinator's veto STOPs before the record POST (record 0)", async () => {
    { const bk = await authorizedBooking(); await refundObs(bk, { amountRefundedMinor: 100 }); const w = pgWorld(bk); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.lock], ["STOP", "ADMISSION_REFUSED:PAYMENT_REFUND_OBSERVED", 0, "not_acquired"]); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { afterCapture: async () => { await refundObs(bk, { refunded: true }); } }); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.sends.capture, r.sends.record, w.records, r.possiblyEffected], ["STOP", 1, 0, 0, true], JSON.stringify(r));
      assert.match(r.code, /PAYMENT_REFUND_OBSERVED/); assert.equal((await snap(bk.id)).st.state, "payment_captured"); }
  });

  test("P6 PG fresh-proof mismatch / staleness: PI amount mismatch at start → zero sends; PI canceled after the create (stale authorization) → STOP before capture (capture 0); PI refunded after the capture step committed → the runner's before-recording proof STOPs (record 0); stale expected version → refused before the lock", async () => {
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { piAmount: bk.total + 100 }); const r = await pgRun(bk, w);
      assert.deepEqual([r.code, writesOf(w).length, r.coordinatorInvocations], ["PROVIDER_PROOF_FAILED:PAYMENT_INTENT_IDENTITY", 0, 0]); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { afterCreate: (ww) => { ww.piStatus = "canceled"; } }); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.sends.create, r.sends.capture, w.captures], ["STOP", 1, 0, 0], JSON.stringify(r)); assert.match(r.code, /FRESH_PROOF_NOT_REQUIRES_CAPTURE/);
      assert.equal((await snap(bk.id)).st.state, "reservation_confirmed"); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { refundOnceCapturedDurably: true }); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.sends.capture, r.sends.record, w.records], ["STOP", 1, 0, 0], JSON.stringify(r)); assert.match(r.code, /FRESH_PROOF_CHARGE_REFUNDED_FLAG/); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk); const r = await pgRun(bk, w, {}, { expectedVersion: (await version(bk.id)) - 1 });
      assert.deepEqual([r.code, w.calls.length], ["ADMISSION_REFUSED:VERSION_NOT_PINNED", 0]); }
  });

  test("P7 PG historical exclusion: an intent created before notBefore is HISTORIC (zero sends); a pinned ref / PI / amount mismatch refuses read-only; a C82 protected id never reaches the core", async () => {
    const bk = await authorizedBooking();
    for (const [over, k] of [[{ notBefore: new Date(bk.base + MIN).toISOString() }, "ADMISSION_REFUSED:HISTORIC_INTENT"], [{ ref: "MV-OTHER01" }, "ADMISSION_REFUSED:REF_NOT_PINNED"],
      [{ paymentIntentId: "pi_test_other0001" }, "ADMISSION_REFUSED:PAYMENT_INTENT_NOT_PINNED"], [{ amountMinor: bk.total + 1 }, "ADMISSION_REFUSED:AMOUNT_NOT_PINNED"],
      [{ intentId: "c83c1842-d342-4e27-9ab7-dc3d50b7a309" }, "CORE_INVALID"]]) {
      const w = pgWorld(bk); const r = await pgRun(bk, w, {}, over);
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.coordinatorInvocations], ["STOP", k, 0, 0], k);
    }
  });

  test("P8 PG lock / abort / deadline: another session holds LOCK_KEY → LOCK_NOT_ACQUIRED, zero provider calls; a pre-aborted run signal → STOP before any read; the wall deadline reserve → PENDING DEADLINE_RESERVE with zero writes (never self-retried)", async () => {
    { const bk = await authorizedBooking(); const holder = new pg.Client({ connectionString: db.reportUrl() }); await holder.connect();
      try { await holder.query("SELECT pg_advisory_lock(pg_catalog.hashtext($1), 0)", [LK.LOCK_KEY]);
        const w = pgWorld(bk); const r = await pgRun(bk, w);
        assert.deepEqual([r.code, w.calls.length, r.lock], ["LOCK_NOT_ACQUIRED:RUN_LOCK_PRESENT", 0, "not_acquired"]);
      } finally { await holder.end(); } }
    { const bk = await authorizedBooking(); const ac = new AbortController(); ac.abort(); const w = pgWorld(bk); const r = await pgRun(bk, w, { runSignal: ac.signal });
      assert.deepEqual([r.outcome, r.code, w.calls.length, r.stopReason], ["STOP", "STOP_ABORTED", 0, "ABORTED"]); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk); let n = 0; const now = () => { n += 1; return n <= 3 ? Date.now() : Date.now() + C.budgets.runMs; };
      const r = await pgRun(bk, w, { now });
      assert.deepEqual([r.outcome, r.code, writesOf(w).length, r.coordinatorInvocations, r.lock], ["PENDING", "PENDING:DEADLINE_RESERVE", 0, 1, "released"], JSON.stringify(r)); }
  });

  test("P9 PG durable-success postcheck failure: the coordinator reports CONFIRMED but the durable readback disagrees (offline_charge_id not linked) → STOP POSTCHECK_MISMATCH, verifiedCompletion false, possiblyEffected true (writes happened; no repair, no repeat)", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk);
    const tamper = (res, sql) => (/e7hpl:row/.test(String(sql)) && res.rows[0] && res.rows[0].state === "confirmed" ? { ...res, rows: [{ ...res.rows[0], och: "999" }] } : res);
    // C91: the runner routes EVERY statement through a tracked client (pool.connect), so the tamper sits on the client
    const pool = { query: async (sql, params) => tamper(await db.app.query(sql, params), sql),
      connect: async () => { const cl = await db.app.connect(); return { query: async (sql, params) => tamper(await cl.query(sql, params), sql), release: (x) => cl.release(x), on: (...a) => cl.on(...a), removeListener: (...a) => cl.removeListener(...a) }; } };
    const r = await pgRun(bk, w, { pool });
    assert.deepEqual([r.outcome, r.code, r.verifiedCompletion, r.possiblyEffected, r.coordinator.outcome, r.sends], ["STOP", "POSTCHECK_MISMATCH:OFFLINE_CHARGE_NOT_LINKED", false, true, "CONFIRMED", { create: 1, capture: 1, record: 1 }], JSON.stringify(r));
  });
  test("P10 PG C91-F1 mid-run seal (REAL coordinator + workers): a worker statement after the ONE create is held in flight when the deadline fires → STOP STOP_DEADLINE within 40 ms, UNKNOWN DB outcome ⇒ possiblyEffected; its connection (and the lock session) destroyed; the LATE result is discarded — no capture / record send ever; a later dispatch refuses with zero writes", async () => {
    const bk = await authorizedBooking(); const w = pgWorld(bk); const T = timers(); const held = []; let destroyedReal = 0;
    const pool = { query: () => { throw new Error("every statement must go through a tracked client"); },
      connect: async () => { const cl = await db.app.connect(); return {
        query: (sql, params) => { const qp = cl.query(sql, params);
          if (w.creates === 1 && held.length === 0 && !/e7hpl:/.test(String(sql))) { const d = deferred(); held.push({ d, qp }); qp.then((v) => held[0].v = v, (e) => held[0].e = e); return d.p; }
          return qp; },
        release: (x) => { if (x === true) destroyedReal += 1; cl.release(x); }, on: (...a) => cl.on(...a), removeListener: (...a) => cl.removeListener(...a) }; } };
    const lockClientFactory = async () => { const cl = await db.app.connect(); return { query: (a, b) => cl.query(a, b), release: (x) => { if (x === true) destroyedReal += 1; cl.release(x); }, on: (...a) => cl.on(...a) }; };
    const core = pgRun(bk, w, { pool, lockClientFactory, timer: T.timer, clearTimer: T.clearTimer });
    for (let i = 0; i < 400 && held.length === 0; i++) await tick(10);
    assert.equal(held.length, 1, "a worker statement is in flight after the create"); assert.equal(w.creates, 1);
    T.fire("deadline");
    const r = await race40(core);
    assert.notEqual(r, "STILL_PENDING_AFTER_DEADLINE", "the seal ends the run even though the statement never returned");
    assert.deepEqual([r.outcome, r.code, r.sealed, r.dbOutcomeUnknown, r.possiblyEffected, r.verifiedCompletion, r.sends], ["STOP", "STOP_DEADLINE", true, true, true, false, { create: 1, capture: 0, record: 0 }], JSON.stringify(r));
    assert.ok(destroyedReal >= 2, "the in-flight worker connection and the lock session are destroyed");
    held[0].d.res({ rows: [], rowCount: 0 }); await tick(300);
    assert.deepEqual([w.captures, w.records, writesOf(w).length], [0, 0, 1], "the late result resumes nothing");
    for (let i = 0; i < 50; i++) { if ((await snap(bk.id)).locks === 0) break; await tick(20); }
    assert.equal((await snap(bk.id)).locks, 0, "the destroyed lock session released the advisory lock");
    const w2 = pgWorld(bk); const r2 = await pgRun(bk, w2);
    assert.equal(r2.outcome, "STOP"); assert.equal(writesOf(w2).length, 0, JSON.stringify(r2));
  });

  test("P11 PG contract + C91-F2 no-write regressions (REAL coordinator): the wrapper's boundary proofs DEPEND on the awaited afterStep throw→STOP seam — a failed boundary hook blocks the NEXT worker and its write: dispute unknown at start → zero sends; malformed dispute after the create → no capture step, capture 0; malformed dispute after the capture committed → no recording step, record 0", async () => {
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { disputeAbsent: true }); const r = await pgRun(bk, w);
      assert.deepEqual([r.code, writesOf(w).length, r.coordinatorInvocations], ["PROVIDER_PROOF_FAILED:CHARGE_DISPUTE_UNKNOWN", 0, 0]); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { afterCreate: (ww) => { ww.disputed = "true"; } }); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.coordinator.outcome, r.coordinator.code], ["STOP", "STOP", "STEP_THREW_FRESH_PROOF_CHARGE_DISPUTE_UNKNOWN"], JSON.stringify(r));
      assert.ok(r.coordinator.steps.every((x) => x.phase === "reservation"), "no capture worker step after the failed hook");
      assert.deepEqual([r.sends.capture, r.coordinator.writes.capture, w.captures], [0, 0, 0]); assert.equal((await snap(bk.id)).st.state, "reservation_confirmed"); }
    { const bk = await authorizedBooking(); const w = pgWorld(bk, { disputeOnceCapturedDurably: null }); const r = await pgRun(bk, w);
      assert.deepEqual([r.outcome, r.coordinator.code], ["STOP", "STEP_THREW_FRESH_PROOF_CHARGE_DISPUTE_UNKNOWN"], JSON.stringify(r));
      assert.ok(!r.coordinator.steps.some((x) => x.phase === "recording"), "no recording worker step after the failed hook");
      assert.deepEqual([r.sends.capture, r.sends.record, r.coordinator.writes.record, w.records], [1, 0, 0, 0]); assert.equal((await snap(bk.id)).st.state, "payment_captured"); }
  });
}
