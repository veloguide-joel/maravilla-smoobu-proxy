// Synthetic tests for scripts/e7-connected/stage-run-package.mjs — FAKE ids only, temp dirs only, no network / DB / provider / credentials.
// Runs the real CLI as a child under `env -i` with the current node; the CLI requires exactly v22.22.0, so the native-run cases are skipped
// on any other node (the pure cases still run).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, planFromFacts, buildStaged, readClosure, decodeFacts, destinationOk, writeExclusive } from "../scripts/e7-connected/stage-run-package.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import { RUN_PLAN_CLOSURE, buildRunPackageV1 } from "../scripts/e7-connected/run-plan-v1.mjs";
import { R1_EXECUTOR_CLOSURE } from "../scripts/e7-connected/run-binding-r1.mjs";
import { PRESENT_KEYS } from "../scripts/e7-connected/probe-env-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts/e7-connected/stage-run-package.mjs");
// PR #67 (0019 test-cleanup foundation) updates intent-state.js / repo.js / operations.js, also part of the executor closure.
// PR #75 (0021 recorded TEST cleanup foundation rev2, ROOT 5884658427) updates intent-state.js / codec.js / repo.js / operations.js and adds
// test-cleanup-recorded.js (not in the closure lists; executor list unchanged at 30 files): executor digest recomputed independently.
const EXEC = "cfefc29ccdef812b839e3f193fc6e5ddee6a9c24afc635b45d5941a143fca22a";
const NATIVE22 = process.version === "v22.22.0";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const iso = (t) => new Date(t).toISOString();
const day = (t) => iso(t).slice(0, 10);
const ENV22 = Object.freeze({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: Object.freeze(Object.fromEntries(PRESENT_KEYS.map((k) => [k, false]))) });
const FND = readClosure(ROOT, RUN_PLAN_CLOSURE); const EXE = readClosure(ROOT, R1_EXECUTOR_CLOSURE);

function facts(now, over = {}) {
  const arr = now + 10 * 86400000;
  return { schema: "e7-g3b-intent-facts-v2", matched: 1, facts: { intentId: "00000000-0000-4000-8000-0000000000a1", expectedRef: "MV-FAKE0A01", environment: "test",
    state: "payment_authorized", version: 4, listingId: 606998, arrival: day(arr), departure: day(arr + 86400000), guests: 1, amountMinor: 14000, currency: "USD",
    rateBps: 1000, paymentIntentId: "pi_FAKEFAKEFAKE00A1", livemode: false, authorizedMinor: 14000, priceConfirmedTransitions: 1,
    priceConfirmedAt: iso(now - 300000), authorizationCreatedAt: iso(now - 120000), authorizationAcceptedAt: iso(now - 118000),
    firstPaymentAuthorizedTransitionAt: iso(now - 118000), quoteExpiresAt: iso(now + 1500000), captureBefore: iso(now + 6 * 86400000),
    authorizationDeadline: iso(now + 4 * 86400000), reservationId: null, dbNow: iso(now - 60000), ...over } };
}
/** the reviewer's precompute: same pure pieces, target env 22.22.0/linux */
function expected(runId, f, createdAt, evaluatedAt) {
  const p = planFromFacts(f.facts, runId, createdAt); assert.ok(p.plan);
  const planBytes = Buffer.from(`${canonicalJson(p.plan)}\n`);
  const b = buildRunPackageV1({ planBytes: new Uint8Array(planBytes), sourceEntries: FND, envSnapshot: ENV22, planClock: Date.parse(evaluatedAt) });
  assert.equal(b.ok, true, b.code);
  return { planSha256: sha(planBytes), packageHash: b.packageHash, packageSha256: sha(Buffer.from(`${canonicalJson(b.package)}\n`)) };
}
function argv(o) { return Object.entries(o).flatMap(([k, v]) => [k, v]); }
function flagsFor(runId, pkgDir, f, createdAt, evaluatedAt, e = expected(runId, f, createdAt, evaluatedAt)) {
  return { "--run-id": runId, "--package-dir": pkgDir, "--facts-b64": Buffer.from(JSON.stringify(f)).toString("base64"), "--created-at": createdAt,
    "--evaluated-at": evaluatedAt, "--expect-plan-sha256": e.planSha256, "--expect-package-hash": e.packageHash, "--expect-executor-digest": EXEC };
}
function tree(mode = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "e7stage-")));
  const P = path.join(base, ".maravilla-private"); const runs = path.join(P, "runs"); const run = path.join(runs, "e7-g3b-fake-r01"); const pkg = path.join(run, "package");
  for (const d of [P, runs, run, pkg, path.join(run, "journal"), path.join(run, "head")]) fs.mkdirSync(d, { mode: 0o700 });
  for (const [k, m] of Object.entries(mode)) fs.chmodSync({ P, runs, run, pkg }[k], m);
  return { base, P, runs, run, pkg };
}
function runCli(args, umask = "077") {
  const r = spawnSync("/bin/sh", ["-c", `umask ${umask}; exec /usr/bin/env -i TERM=xterm-256color LANG=C.UTF-8 "$0" "$@"`, process.execPath, CLI, ...args], { encoding: "utf8", input: "" });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null, err: r.stderr };
}
const snap = (dir) => { const out = []; const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.lstatSync(p); out.push(`${path.relative(dir, p)}:${st.mode.toString(8)}:${st.size}`); if (st.isDirectory() && (st.mode & 0o400)) walk(p); } }; walk(dir); return out.join("|"); };

test("parseArgs: exact 8 flags, typed, once each", () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000);
  const ok = flagsFor("e7-g3b-fake-r01", "/x/.maravilla-private/runs/e7-g3b-fake-r01/package", f, c, c);
  assert.ok(parseArgs(argv(ok)));
  assert.equal(parseArgs(argv({ ...ok, "--run-id": "BAD" })), null);
  assert.equal(parseArgs(argv({ ...ok, "--package-dir": "rel/path" })), null);
  assert.equal(parseArgs([...argv(ok), "--run-id", "e7-g3b-fake-r01"]), null);
  assert.equal(parseArgs(argv(ok).slice(2)), null);
});

test("pure: mapping refusals (no substitution)", () => {
  const now = Date.now(); const c = iso(now - 30000);
  const P = (o) => planFromFacts(facts(now, o).facts, "e7-g3b-fake-r01", c);
  assert.equal(P({ priceConfirmedTransitions: 2 }).error, "PRICE_CONFIRMED_NOT_EXACTLY_ONE");
  assert.equal(P({ authorizationCreatedAt: null }).error, "TIMESTAMP_MISSING");
  assert.equal(P({ authorizationCreatedAt: iso(now - 400000) }).error, "PROVIDER_AUTH_BEFORE_QUOTE");
  assert.equal(P({ authorizationAcceptedAt: iso(now - 200000) }).error, "LOCAL_ACCEPTANCE_BEFORE_PROVIDER_AUTH");
  assert.equal(P({ livemode: true }).error, "FACT_SCOPE");
  assert.equal(P({ reservationId: "123" }).error, "FACT_STATE");
  assert.equal(P({ rateBps: 6000 }).error, "RATE_OVER_BINDER_CAP");
  assert.equal(decodeFacts(Buffer.from(JSON.stringify({ ...facts(now), matched: 2 })).toString("base64")).error, "FACTS_NOT_EXACTLY_ONE");
});

test("pure buildStaged: OK, pins, clock, stale quote", () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000);
  const fl = parseArgs(argv(flagsFor("e7-g3b-fake-r01", "/x/.maravilla-private/runs/e7-g3b-fake-r01/package", f, c, c)));
  const ok = buildStaged({ flags: fl, envSnapshot: ENV22, now, foundationSources: FND, executorSources: EXE });
  assert.equal(ok.ok, true, ok.code);
  const bad = parseArgs(argv({ ...flagsFor("e7-g3b-fake-r01", "/x/.maravilla-private/runs/e7-g3b-fake-r01/package", f, c, c), "--expect-package-hash": "0".repeat(64) }));
  assert.equal(buildStaged({ flags: bad, envSnapshot: ENV22, now, foundationSources: FND, executorSources: EXE }).code, "PACKAGE_HASH_MISMATCH");
  const badp = parseArgs(argv({ ...flagsFor("e7-g3b-fake-r01", "/x/.maravilla-private/runs/e7-g3b-fake-r01/package", f, c, c), "--expect-plan-sha256": "0".repeat(64) }));
  assert.equal(buildStaged({ flags: badp, envSnapshot: ENV22, now, foundationSources: FND, executorSources: EXE }).code, "PLAN_SHA_MISMATCH");
  const bade = parseArgs(argv({ ...flagsFor("e7-g3b-fake-r01", "/x/.maravilla-private/runs/e7-g3b-fake-r01/package", f, c, c), "--expect-executor-digest": "0".repeat(64) }));
  assert.equal(buildStaged({ flags: bade, envSnapshot: ENV22, now, foundationSources: FND, executorSources: EXE }).code, "BINDER_R1_EXECUTOR_DIGEST_MISMATCH");
  assert.equal(buildStaged({ flags: fl, envSnapshot: ENV22, now: now - 60000, foundationSources: FND, executorSources: EXE }).code, "CLOCK_BEHIND_EVALUATED_AT");
  assert.equal(buildStaged({ flags: fl, envSnapshot: ENV22, now: now + 31 * 60000, foundationSources: FND, executorSources: EXE }).code, "PLAN_QUOTE_TOO_OLD");
  assert.equal(buildStaged({ flags: fl, envSnapshot: { ...ENV22, nodeVersion: "24.22.1" }, now, foundationSources: FND, executorSources: EXE }).code, "NODE_NOT_22_22_0");
});

test("CLI (native v22.22.0): staging matrix in temp trees", { skip: !NATIVE22 && "needs exact node v22.22.0" }, () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000);
  const go = (t, extra = {}) => runCli(argv({ ...flagsFor("e7-g3b-fake-r01", t.pkg, f, c, c), ...extra }));
  // 1 fresh → staged, exact bytes, 0600, journal/head untouched
  let t = tree(); const e = expected("e7-g3b-fake-r01", f, c, c);
  let r = go(t); assert.equal(r.out.code, "PACKAGE_STAGED", JSON.stringify(r));
  assert.equal(r.out.packageHash, e.packageHash); assert.equal(sha(fs.readFileSync(path.join(t.pkg, "package.json"))), e.packageSha256);
  assert.equal(sha(fs.readFileSync(path.join(t.pkg, "plan.json"))), e.planSha256);
  for (const n of ["plan.json", "package.json"]) assert.equal(fs.statSync(path.join(t.pkg, n)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(t.run, "journal")), []); assert.deepEqual(fs.readdirSync(path.join(t.run, "head")), []);
  // 2 rerun → NOT_EMPTY, unchanged
  let s0 = snap(t.base); r = go(t); assert.equal(r.out.code, "PACKAGE_DIR_NOT_EMPTY"); assert.equal(snap(t.base), s0);
  // 3 stray file
  t = tree(); fs.writeFileSync(path.join(t.pkg, "stray"), "x"); s0 = snap(t.base); r = go(t); assert.equal(r.out.code, "PACKAGE_DIR_NOT_EMPTY"); assert.equal(snap(t.base), s0);
  // 4-7 modes on package / run / runs / private
  for (const k of ["pkg", "run", "runs", "P"]) { t = tree({ [k]: 0o755 }); s0 = snap(t.base); r = go(t); assert.equal(r.out.code, "DIR_INVALID", k); assert.equal(snap(t.base), s0); }
  // 8 package is a symlink to a 0700 dir
  t = tree(); fs.rmdirSync(t.pkg); fs.mkdirSync(path.join(t.run, "real"), { mode: 0o700 }); fs.symlinkSync(path.join(t.run, "real"), t.pkg);
  s0 = snap(t.base); r = go(t); assert.equal(r.out.code, "DIR_INVALID"); assert.equal(snap(t.base), s0);
  // 9 runs is a symlink (non-canonical ancestor)
  t = tree(); const alt = path.join(t.base, "alt"); fs.mkdirSync(alt, { mode: 0o700 }); fs.renameSync(t.runs, path.join(alt, "runs")); fs.symlinkSync(path.join(alt, "runs"), t.runs);
  s0 = snap(t.base); r = go(t); assert.equal(r.out.code, "DIR_INVALID"); assert.equal(snap(t.base), s0);
  // 10 wrong pins → no write
  t = tree(); r = go(t, { "--expect-package-hash": "0".repeat(64) }); assert.equal(r.out.code, "PACKAGE_HASH_MISMATCH"); assert.deepEqual(fs.readdirSync(t.pkg), []);
  // 11 facts with 2 matched → no write
  t = tree(); r = go(t, { "--facts-b64": Buffer.from(JSON.stringify({ ...f, matched: 2 })).toString("base64") }); assert.equal(r.out.code, "FACTS_NOT_EXACTLY_ONE"); assert.deepEqual(fs.readdirSync(t.pkg), []);
  // 12 evaluated-at in the future → no write
  t = tree(); const fut = iso(now + 3600000); r = go(t, { "--evaluated-at": fut }); assert.equal(r.out.code, "CLOCK_BEHIND_EVALUATED_AT"); assert.deepEqual(fs.readdirSync(t.pkg), []);
  // 13 usage
  r = runCli(["--run-id", "x"]); assert.equal(r.out.code, "USAGE");
  // 14 refused env variable present (NODE_OPTIONS) → no write
  t = tree();
  const rr = spawnSync("/usr/bin/env", ["-i", "NODE_OPTIONS=", process.execPath, CLI, ...argv(flagsFor("e7-g3b-fake-r01", t.pkg, f, c, c))], { encoding: "utf8", input: "" });
  assert.match(JSON.parse(rr.stdout.trim()).code, /^ENV_/); assert.deepEqual(fs.readdirSync(t.pkg), []);
});

test("CLI: never reads stdin (closed stdin, no prompt, single stdout line)", { skip: !NATIVE22 && "needs exact node v22.22.0" }, () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000); const t = tree();
  const r = spawnSync("/usr/bin/env", ["-i", process.execPath, CLI, ...argv(flagsFor("e7-g3b-fake-r01", t.pkg, f, c, c))], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.stdout.trim().split("\n").length, 1); assert.equal(JSON.parse(r.stdout).code, "PACKAGE_STAGED"); assert.equal(r.stderr, "");
});

test("rev2 F1 pure: destination namespace binding", () => {
  const R = "e7-g3b-fake-r01";
  assert.equal(destinationOk(`/h/.maravilla-private/runs/${R}/package`, R, "/repo"), null);
  assert.equal(destinationOk(`/h/.maravilla-private/runs/${R}/journal`, R, "/repo"), "DESTINATION_NOT_PACKAGE");
  assert.equal(destinationOk(`/h/.maravilla-private/runs/${R}/head`, R, "/repo"), "DESTINATION_NOT_PACKAGE");
  assert.equal(destinationOk(`/h/.maravilla-private/runs/e7-g3b-other-r09/package`, R, "/repo"), "DESTINATION_RUN_ID_MISMATCH");
  assert.equal(destinationOk(`/h/a/b/${R}/package`, R, "/repo"), "DESTINATION_NAMESPACE_INVALID");
  assert.equal(destinationOk(`/h/priv/runs/${R}/package`, R, "/repo"), "DESTINATION_NAMESPACE_INVALID");
  assert.equal(destinationOk(`/repo/x/.maravilla-private/runs/${R}/package`, R, "/repo"), "DESTINATION_IN_REPO");
  assert.equal(destinationOk(`/h/.git/.maravilla-private/runs/${R}/package`, R, "/repo"), "DESTINATION_IN_REPO");
  assert.equal(destinationOk(`${ROOT}/.maravilla-private/runs/${R}/package`, R), "DESTINATION_IN_REPO");
  assert.equal(destinationOk("rel/package", R, "/repo"), "DESTINATION_INVALID");
});

test("rev2 F1 CLI: journal / head / runId mismatch / arbitrary 0700 dirs refused before any I/O", { skip: !NATIVE22 && "needs exact node v22.22.0" }, () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000);
  for (const leaf of ["journal", "head"]) {
    const t = tree(); const s0 = snap(t.base);
    const r = runCli(argv(flagsFor("e7-g3b-fake-r01", path.join(t.run, leaf), f, c, c)));
    assert.equal(r.out.code, "DESTINATION_NOT_PACKAGE", leaf); assert.equal(snap(t.base), s0);
    assert.deepEqual(fs.readdirSync(path.join(t.run, "journal")), []); assert.deepEqual(fs.readdirSync(path.join(t.run, "head")), []);
  }
  let t = tree(); let s0 = snap(t.base);
  let r = runCli(argv(flagsFor("e7-g3b-other-r09", t.pkg, f, c, c))); assert.equal(r.out.code, "DESTINATION_RUN_ID_MISMATCH"); assert.equal(snap(t.base), s0);
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "e7arb-"))); const a = path.join(base, "a"); const b = path.join(a, "b"); const cc = path.join(b, "e7-g3b-fake-r01"); const pk = path.join(cc, "package");
  for (const d of [a, b, cc, pk]) fs.mkdirSync(d, { mode: 0o700 });
  s0 = snap(base); r = runCli(argv(flagsFor("e7-g3b-fake-r01", pk, f, c, c))); assert.equal(r.out.code, "DESTINATION_NAMESPACE_INVALID"); assert.equal(snap(base), s0);
});

test("rev2 F2 CLI: inherited umask — 0600 only; restrictive umask refused, created file left in place, never chmod-repaired", { skip: !NATIVE22 && "needs exact node v22.22.0" }, () => {
  const now = Date.now(); const f = facts(now); const c = iso(now - 30000);
  for (const um of ["0222", "0277", "0400"]) {
    const t = tree(); const r = runCli(argv(flagsFor("e7-g3b-fake-r01", t.pkg, f, c, c)), um);
    assert.equal(r.out.code, "PLAN_MODE_UNSUPPORTED_LEFT_IN_PLACE", um);
    assert.deepEqual(fs.readdirSync(t.pkg), ["plan.json"]);
    const st = fs.statSync(path.join(t.pkg, "plan.json")); assert.equal(st.size, 0); assert.notEqual(st.mode & 0o777, 0o600);
  }
  for (const um of ["0000", "0022", "0077", "0177"]) {
    const t = tree(); const r = runCli(argv(flagsFor("e7-g3b-fake-r01", t.pkg, f, c, c)), um);
    assert.equal(r.out.code, "PACKAGE_STAGED", um);
    for (const n of ["plan.json", "package.json"]) assert.equal(fs.statSync(path.join(t.pkg, n)).mode & 0o777, 0o600);
  }
});

test("rev2 writeExclusive: zero-byte progress is a prompt fixed failure (no loop / retry)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "e7wx-"))); const p = path.join(dir, "f.json");
  let calls = 0; const io = { ...fs, writeSync: () => { calls += 1; return 0; } };
  const t0 = Date.now(); const code = writeExclusive(p, Buffer.from("abc"), process.getuid(), io);
  assert.equal(code, "WRITE_NO_PROGRESS_LEFT_IN_PLACE"); assert.equal(calls, 1); assert.ok(Date.now() - t0 < 1000);
  assert.ok(fs.existsSync(p));                                                   // left in place
  assert.equal(writeExclusive(p, Buffer.from("abc"), process.getuid()), "CREATE_FAILED");   // exclusive: never overwritten
  const p2 = path.join(dir, "g.json"); const bad = { ...fs, writeSync: () => 99 };
  assert.equal(writeExclusive(p2, Buffer.from("abc"), process.getuid(), bad), "WRITE_NO_PROGRESS_LEFT_IN_PLACE");
});
