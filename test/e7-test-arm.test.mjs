// test/e7-test-arm.test.mjs — C119 S2: the TEST ARM gate (scripts/e7-test-arm.mjs + scripts/e7-test-arm/manifest.json) and the arm re-checks of the two
// runners (labelled copies). Zero network, zero secrets, no database: every real network primitive is a throwing guard; runner tests use the
// TEST-LOCAL constants seam (executeEnabled opened in the test only) with deps that throw if anything past the arm gate is reached.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const GUARD = { request: 0, fetch: 0 };
https.request = () => { GUARD.request += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => assert.deepEqual(GUARD, { request: 0, fetch: 0 }, "no network primitive touched"));

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const A = await import("../scripts/e7-test-arm.mjs");
const K = await import("../scripts/e7-hosted-kickoff.mjs");
const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const MANIFEST = readFileSync(join(ROOT, A.ARM_MANIFEST_PATH), "utf8");
const M = JSON.parse(MANIFEST);
const FILES = [A.ARM_MANIFEST_PATH, ...M.components.flatMap((x) => x.files)];
const R0 = await A.armRelease(ROOT);
const copyTree = (mut = () => {}) => { const d = mkdtempSync(join(tmpdir(), "e7-arm-")); for (const f of FILES) { mkdirSync(dirname(join(d, f)), { recursive: true }); writeFileSync(join(d, f), readFileSync(join(ROOT, f))); } mut(d); return d; };
const withTree = async (mut, fn) => { const d = copyTree(mut); try { return await fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test("A1 release digest: deterministic, recomputed from the bytes (an exact copy of the components + manifest gives the SAME release), exactly the documented construction; the four reviewed components in order; ACYCLIC — no component file and not the manifest contains the release or any component frame digest; the cross-runner regression and the manifest are outside every component", async () => {
  assert.equal(R0.ok, true); assert.match(R0.release, /^[0-9a-f]{64}$/);
  assert.deepEqual(M.components.map((x) => x.name), ["arm-gate", "kickoff", "booking-confirmation", "pipeline"]); assert.deepEqual([...A.REQUIRED_COMPONENTS], M.components.map((x) => x.name));
  assert.equal(await withTree(() => {}, async (d) => (await A.armRelease(d)).release), R0.release, "an exact copy reproduces the release");
  const frame = (files, prefix) => { const h = createHash("sha256"); h.update(prefix); for (const f of files) { const b = readFileSync(join(ROOT, f)); h.update(f); h.update(Buffer.from([0])); h.update(String(b.length)); h.update(Buffer.from([0])); h.update(b); h.update(Buffer.from([0])); } return h.digest("hex"); };
  const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`);
  const comps = M.components.map((x) => ({ name: x.name, frame: frame(x.files, x.prefix) }));
  assert.equal(sha(canon({ schema: "e7-test-arm-release-v1", manifest: sha(readFileSync(join(ROOT, A.ARM_MANIFEST_PATH))), components: comps })), R0.release, "the documented construction, recomputed independently");
  assert.deepEqual(Object.values(R0.frames), comps.map((x) => x.frame));
  assert.deepEqual(M.components[1].files, [...K.RUNNER_FILES]); assert.equal(M.components[1].prefix, K.SOURCE_PREFIX); assert.equal(R0.frames.kickoff, await K.framedDigest(ROOT, K.RUNNER_FILES, K.SOURCE_PREFIX));
  assert.deepEqual(M.components[2].files, [...N.CONSTANTS.runnerFiles]); assert.equal(M.components[2].prefix, N.SOURCE_DIGEST_PREFIX);
  assert.equal(R0.frames["booking-confirmation"], await N.framedDigest(ROOT, N.CONSTANTS.runnerFiles, N.SOURCE_DIGEST_PREFIX));
  assert.deepEqual(M.components[3].files, [...K.CONSTANTS.pipeline.runnerFiles], "the pipeline frame the kickoff binds");
  assert.equal(R0.frames.pipeline, "cfe62d4d8b3eaeb739576b8762ee4b3753d47e4f8ed8258696ca40406a66e2d4", "S2 leaves the pipeline bytes untouched (the CLOSED main frame)");
  assert.deepEqual(M.components[0].files, ["scripts/e7-test-arm.mjs", "test/e7-test-arm.test.mjs"]);
  assert.doesNotMatch(MANIFEST, /[0-9a-f]{40,}/, "the manifest lists names / prefixes / files only — never a digest");
  // a component may pin the UNTOUCHED pipeline's frame (kickoff already does; the pipeline embeds nothing of ours), but NO file in the release embeds the
  // release itself or the frame of any component that changes with S2 (arm gate / kickoff / confirmation) — so nothing depends on its own result
  for (const f of FILES) { const t = readFileSync(join(ROOT, f), "utf8"); for (const v of [R0.release, R0.frames["arm-gate"], R0.frames.kickoff, R0.frames["booking-confirmation"]]) assert.ok(!t.includes(v), `${f} must not embed ${v.slice(0, 8)}…`); }
  for (const f of M.components[3].files) { const t = readFileSync(join(ROOT, f), "utf8"); assert.doesNotMatch(t, /e7-test-arm|E7_TEST_AUTO_ARMED/, `the pipeline component ${f} knows nothing of the arm (acyclic)`); }
  for (const f of A.OUTSIDE_EVERY_COMPONENT) assert.ok(!M.components.some((x) => x.files.includes(f)), `${f} is outside every component`);
});

test("A2 arm decision truth table: absent / empty → ARM_ABSENT; malformed (case, length, whitespace, prefix, non-string) → ARM_MALFORMED; a ref other than refs/heads/main → ARM_REF_NOT_MAIN; any other 64-hex (stale / another release) → ARM_MISMATCH; ONLY the recomputed release on main → ARMED (with the component frames)", async () => {
  const ok = await A.armDecision({ dir: ROOT, value: R0.release, ref: "refs/heads/main" });
  assert.deepEqual([ok.armed, ok.code, ok.release, ok.frames], [true, "ARMED", R0.release, R0.frames]);
  for (const [value, ref, code] of [[undefined, "refs/heads/main", "ARM_ABSENT"], [null, "refs/heads/main", "ARM_ABSENT"], ["", "refs/heads/main", "ARM_ABSENT"],
    [R0.release.toUpperCase(), "refs/heads/main", "ARM_MALFORMED"], [R0.release.slice(1), "refs/heads/main", "ARM_MALFORMED"], [` ${R0.release}`, "refs/heads/main", "ARM_MALFORMED"],
    [`${R0.release}\n`, "refs/heads/main", "ARM_MALFORMED"], [`sha256:${R0.release}`, "refs/heads/main", "ARM_MALFORMED"], [123, "refs/heads/main", "ARM_MALFORMED"], ["MISSING", "refs/heads/main", "ARM_MALFORMED"],
    [R0.release, "refs/heads/e7-test", "ARM_REF_NOT_MAIN"], [R0.release, "refs/pull/1/merge", "ARM_REF_NOT_MAIN"], [R0.release, undefined, "ARM_REF_NOT_MAIN"],
    ["f".repeat(64), "refs/heads/main", "ARM_MISMATCH"], [R0.frames.kickoff, "refs/heads/main", "ARM_MISMATCH"], [R0.manifest, "refs/heads/main", "ARM_MISMATCH"]]) {
    const d = await A.armDecision({ dir: ROOT, value, ref });
    assert.deepEqual([d.armed, d.code, d.frames], [false, code, null], `${String(value).slice(0, 12)} ${ref}`);
  }
  assert.ok(A.ARM_CODES.includes("ARMED") && A.ARM_CODES.length === 6);
});

test("A3 release changes: ONE byte in ANY component file (arm gate, kickoff, confirmation, pipeline) or ANY manifest change yields a different (or unreadable) release, so a previously set arm value is STALE → not armed; a malformed manifest (order, keys, schema, traversal, duplicates, the manifest / the cross-runner regression listed, oversize, missing file) → ARM_RELEASE_UNREADABLE", async () => {
  for (const f of M.components.flatMap((x) => x.files)) {
    await withTree((d) => writeFileSync(join(d, f), Buffer.concat([readFileSync(join(d, f)), Buffer.from(" ")])), async (d) => {
      const r = await A.armRelease(d); assert.equal(r.ok, true); assert.notEqual(r.release, R0.release, f);
      assert.equal((await A.armDecision({ dir: d, value: R0.release, ref: "refs/heads/main" })).code, "ARM_MISMATCH", `${f}: the old arm is stale`);
    });
  }
  const mm = (fn) => (d) => { const m = JSON.parse(MANIFEST); const out = fn(m); writeFileSync(join(d, A.ARM_MANIFEST_PATH), typeof out === "string" ? out : JSON.stringify(out ?? m, null, 2)); };
  const reformatted = await withTree(mm((m) => JSON.stringify(m)), async (d) => A.armRelease(d));
  assert.equal(reformatted.ok, true); assert.notEqual(reformatted.release, R0.release, "even a whitespace-only manifest change is a new release (the manifest bytes are bound)");
  for (const [why, fn] of [["reordered", (m) => ({ ...m, components: [m.components[1], m.components[0], ...m.components.slice(2)] })], ["missing component", (m) => ({ ...m, components: m.components.slice(0, 3) })],
    ["extra component", (m) => ({ ...m, components: [...m.components, { name: "x", prefix: "x-v1\n", files: ["README.md"] }] })], ["extra key", (m) => ({ ...m, release: "a".repeat(64) })],
    ["schema", (m) => ({ ...m, schema: "e7-test-arm-manifest-v2" })], ["traversal", (m) => { m.components[0].files = ["../etc/passwd"]; return m; }], ["absolute", (m) => { m.components[0].files = ["/etc/passwd"]; return m; }],
    ["duplicate file", (m) => { m.components[3].files = [...m.components[3].files, m.components[1].files[0]]; return m; }], ["self", (m) => { m.components[0].files = [...m.components[0].files, A.ARM_MANIFEST_PATH]; return m; }],
    ["cross-runner", (m) => { m.components[0].files = [...m.components[0].files, "test/e7-cross-runner-regression.test.mjs"]; return m; }], ["bad prefix", (m) => { m.components[1].prefix = "kickoff"; return m; }],
    ["component key", (m) => { m.components[1].digest = "a".repeat(64); return m; }], ["missing file", (m) => { m.components[0].files = ["scripts/does-not-exist.mjs"]; return m; }],
    ["not json", () => "{"], ["oversize", () => " ".repeat(70000)]]) {
    const r = await withTree(mm(fn), async (d) => ({ rel: await A.armRelease(d), dec: await A.armDecision({ dir: d, value: R0.release, ref: "refs/heads/main" }) }));
    assert.deepEqual([r.rel.ok, r.dec.armed, r.dec.code], [false, false, "ARM_RELEASE_UNREADABLE"], why);
  }
});

test("A4 the runners' arm blocks are LABELLED COPIES (byte-equal) of scripts/e7-test-arm.mjs and compute the same release / decision", async () => {
  const block = (t) => { const i = t.indexOf("const ARM_HEX64 = "); const j = t.indexOf("\n// ----", i + 1); assert.ok(i > 0 && j > i); return t.slice(i, j).trimEnd(); };
  const a = block(readFileSync(join(ROOT, "scripts/e7-test-arm.mjs"), "utf8"));
  for (const f of ["scripts/e7-hosted-kickoff.mjs", "scripts/e7-hosted-booking-confirmation.mjs"]) assert.equal(block(readFileSync(join(ROOT, f), "utf8")), a, f);
  for (const X of [K, N]) {
    assert.equal(X.armRelease.toString(), A.armRelease.toString()); assert.equal(X.armDecision.toString(), A.armDecision.toString());
    assert.deepEqual(await X.armRelease(ROOT), R0);
    assert.deepEqual(await X.armDecision({ dir: ROOT, value: R0.release, ref: "refs/heads/main" }), await A.armDecision({ dir: ROOT, value: R0.release, ref: "refs/heads/main" }));
  }
});

test("A5 the ROUTING check (`node scripts/e7-test-arm.mjs check`, the arm job's ONLY step): exit 0 ALWAYS (not armed = CLOSED_NOOP); $GITHUB_OUTPUT gets ONLY armed + (armed only) the two runner frames; the computed release is printed for review; no secret / network / database", () => {
  const run = (env) => { const d = mkdtempSync(join(tmpdir(), "e7-arm-out-")); const out = join(d, "out"); writeFileSync(out, "");
    try { const r = spawnSync(process.execPath, [join(ROOT, "scripts/e7-test-arm.mjs"), "check"], { encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env } });
      return { status: r.status, json: JSON.parse(r.stdout.trim()), out: readFileSync(out, "utf8") }; } finally { rmSync(d, { recursive: true, force: true }); } };
  const ok = run({ E7_TEST_ARM: R0.release, GITHUB_REF: "refs/heads/main" });
  assert.deepEqual([ok.status, ok.json.code, ok.json.computedRelease, ok.out], [0, "ARMED", R0.release, `armed=true\nkickoff=${R0.frames.kickoff}\nconfirmation=${R0.frames["booking-confirmation"]}\n`]);
  for (const [env, reason] of [[{ GITHUB_REF: "refs/heads/main" }, "ARM_ABSENT"], [{ E7_TEST_ARM: "x", GITHUB_REF: "refs/heads/main" }, "ARM_MALFORMED"], [{ E7_TEST_ARM: "f".repeat(64), GITHUB_REF: "refs/heads/main" }, "ARM_MISMATCH"],
    [{ E7_TEST_ARM: R0.release, GITHUB_REF: "refs/heads/feature" }, "ARM_REF_NOT_MAIN"]]) {
    const r = run(env); assert.deepEqual([r.status, r.json.code, r.json.reason, r.out], [0, "CLOSED_NOOP", reason, "armed=false\nkickoff=\nconfirmation=\n"], reason);
  }
  const src = readFileSync(join(ROOT, "scripts/e7-test-arm.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.deepEqual([...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["node:crypto", "node:fs", "node:fs/promises", "node:process", "node:url"]);
  assert.doesNotMatch(src, /secrets|DATABASE_URL|TOKEN|fetch\(|https|\bpg\b|spawn/, "no secret, network, database or child process");
});

// ---- the runners' own arm re-check (TEST-LOCAL seam: executeEnabled opened in the test only; anything past the arm gate throws) ----------
const never = (n) => async () => { throw new Error(`must not be called: ${n}`); };
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const TOOLING = "/nonexistent-tooling";   // never reached: the arm refuses first

test("A6 confirmation runner: verify / detect / execute (manual bound op AND detect flow — no manual bypass) refuse NBC_ARM_CLOSED for an absent / cleared / malformed / mismatched / stale arm BEFORE any tooling import, credential read, DB or provider; manual preflight never needs the arm; SHIPPED CLOSED still refuses first", async () => {
  const OPEN = Object.freeze({ ...N.CONSTANTS, executeEnabled: true });
  const SRC = await N.framedDigest(ROOT, N.CONSTANTS.runnerFiles, N.SOURCE_DIGEST_PREFIX);
  const deps = { constants: OPEN, importEnv: never("importEnv"), importTooling: never("importTooling"), runCore: never("runCore"), runDetect: never("runDetect"), spawnChild: never("spawn"), readPgVersion: never("pg"), readCa: never("ca") };
  const base = { E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: SRC, E7_EXPECTED_CLOSURE_DIGEST: OPEN.closureDigest, E7_WORKFLOW_SHA: "1".repeat(40), E7_RUN_ID: "123456789-1", GITHUB_REF: "refs/heads/main" };
  const bound = { E7_APPROVAL_REF: "l", E7_INTENT_ID: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", E7_OP_ID: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", E7_EXPECTED_VERSION: "9", E7_LOCALE: "en", E7_EXPECTED_PLAN_HASH: "a".repeat(64) };
  const stale = await withTree((d) => writeFileSync(join(d, "test/e7-test-arm.test.mjs"), `${readFileSync(join(d, "test/e7-test-arm.test.mjs"), "utf8")}\n// a later main\n`), async (d) => (await A.armRelease(d)).release);
  const routes = [["verify", { ...bound }], ["execute", { ...bound, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_RESEND_TEST_KEY: "re_x" }], ["verify", { E7_INPUT_MODE: "detect" }],
    ["detect", { E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }], ["execute", { E7_INPUT_MODE: "detect", E7_EXPECTED_CANDIDATE_FINGERPRINT: "b".repeat(64), E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_RESEND_TEST_KEY: "re_x" }]];
  for (const [mode, extra] of routes) for (const [arm, why] of [[undefined, "absent"], ["", "cleared (a queued job started after the variable was cleared)"], ["x", "malformed"], ["f".repeat(64), "mismatched"], [stale, "stale (another release)"]]) {
    let secretReads = 0; const env = new Proxy({ ...base, ...extra, ...(arm === undefined ? {} : { E7_TEST_ARM: arm }) }, { get: (t, k) => { if (k === "E7_DEV_BOOKING_DATABASE_URL" || k === "E7_RESEND_TEST_KEY") secretReads += 1; return t[k]; } });
    const r = await N.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps });
    assert.deepEqual([r.exitCode, r.result.code, secretReads, r.result.core, r.result.detect, r.result.closureDigest], [1, "NBC_ARM_CLOSED", 0, null, null, null], `${mode} ${JSON.stringify(Object.keys(extra))} ${why}`);
  }
  const pre = await N.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: N.CONSTANTS } });
  assert.notEqual(pre.result.code, "NBC_ARM_CLOSED", "manual preflight takes no arm");
  const shipped = await N.runHosted({ mode: "detect", env: { ...base, E7_TEST_ARM: R0.release, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: N.CONSTANTS } });
  assert.equal(shipped.result.code, "NBC_EXECUTE_CLOSED", "SHIPPED CLOSED: a valid arm never opens the closed runner");
  assert.equal(N.CONSTANTS.executeEnabled, false);
});

test("A7 kickoff runner: detect-flow verify NOT armed → CLOSED_NOOP (open=false: the gated jobs are skipped); manual verify / execute and the detect / detect-flow execute → HKO_ARM_CLOSED — all BEFORE any tooling import, secret / token read, DB or HTTP; manual preflight never needs the arm; SHIPPED CLOSED refuses first", async () => {
  const OPEN = Object.freeze({ ...K.CONSTANTS, executeEnabled: true, dispatchEnabled: true });
  const deps = { constants: OPEN, spawnChild: never("spawn"), importEnv: never("importEnv"), importTooling: never("importTooling"), runCore: never("runCore"), readHead: never("readHead"), readPgVersion: never("pg"), readCa: never("ca") };
  const base = { E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: "a".repeat(64), E7_WORKFLOW_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40), GITHUB_REF: "refs/heads/main", E7_RUN_ID: "123456-1" };
  const bound = { E7_INTENT_ID: "11111111-2222-4333-8444-555555555555", E7_BOOKING_REF: "MV-FAKE0001", E7_EXPECTED_VERSION: "6", E7_PAYMENT_INTENT_ID: "pi_3FakeKickoff0001", E7_AMOUNT_MINOR: "56000" };
  for (const arm of [undefined, "", "x", "f".repeat(64)]) {
    const armEnv = arm === undefined ? {} : { E7_TEST_ARM: arm };
    const noop = await K.runHosted({ mode: "verify", env: { ...base, E7_INPUT_MODE: "detect", ...armEnv }, proc: PROC, wrapperDir: ROOT, deps });
    assert.deepEqual([noop.exitCode, noop.result.code, noop.result.outputs], [0, "CLOSED_NOOP", { open: "false" }], `detect verify ${arm}`);
    for (const [mode, extra] of [["verify", bound], ["execute", { ...bound, E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_DISPATCH_TOKEN: "t".repeat(40) }], ["detect", { E7_INPUT_MODE: "detect", E7_DEV_BOOKING_DATABASE_URL: "postgresql://x" }],
      ["execute", { E7_INPUT_MODE: "detect", E7_EXPECTED_CANDIDATE_FINGERPRINT: "b".repeat(64), E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_DISPATCH_TOKEN: "t".repeat(40) }]]) {
      let reads = 0; const env = new Proxy({ ...base, ...extra, ...armEnv }, { get: (t, k) => { if (K.SECRET_KEYS.includes(k)) reads += 1; return t[k]; } });
      const r = await K.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps });
      assert.deepEqual([r.exitCode, r.result.code, reads, r.result.core], [1, "HKO_ARM_CLOSED", 0, null], `${mode} ${Object.keys(extra)} ${arm}`);
    }
  }
  const pre = await K.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: K.CONSTANTS } });
  assert.notEqual(pre.result.code, "HKO_ARM_CLOSED", "manual preflight takes no arm");
  const shipped = await K.runHosted({ mode: "verify", env: { ...base, ...bound, E7_TEST_ARM: R0.release }, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: K.CONSTANTS } });
  assert.equal(shipped.result.code, "HKO_EXECUTE_CLOSED", "SHIPPED CLOSED: a valid arm never opens the closed runner");
  assert.deepEqual([K.CONSTANTS.executeEnabled, K.CONSTANTS.dispatchEnabled], [false, false]);
});
