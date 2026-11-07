// E7 G3b — native EXECUTE boot: grammar, the NATIVE EXECUTION CLOSURE (independent scan + independent digest), and REAL child-process boot
// refusals before sensitive access (contract claude/e7-g3b-native-execute.md §1–§2, §5). OFFLINE: no DB, provider, network or real credential.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync, cpSync, existsSync, readdirSync, mkdirSync, symlinkSync, constants as FS_CONSTANTS } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import * as R from "../scripts/e7-connected/run-binding-r1.mjs";
import * as CLI from "../scripts/e7-connected/run-plan-cli-main.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline G3b boot suite)"); };
const DIRS = [];
after(() => { globalThis.fetch = realFetch; for (const d of DIRS) rmSync(d, { recursive: true, force: true }); assert.equal(netAttempts, 0); });
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const CLI_PATH = join(ROOT, "scripts/e7-connected/run-plan-cli-main.mjs");
const FS_TRACER = join(ROOT, "test/fixtures/e7-g3a-fs-tracer.mjs"); const PROC_TRACER = join(ROOT, "test/fixtures/e7-g3a-process-tracer.mjs");
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); chmodSync(d, 0o700); DIRS.push(d); return d; };
const put = (d, n, t) => { const f = join(d, n); writeFileSync(f, t); chmodSync(f, 0o600); return f; };
const CANARY = "CANARYpw7f3e9Q"; const HTOKEN = "synthetic-hostaway-canary-token"; const SKEY = "sk_test_CanaryKey123";

// ---- the INDEPENDENT scan + digest (this test's own implementation; never the CLI's functions) -----------------------------------
function scan(starts) {
  const seen = new Map(); const ext = new Set();
  const visit = (p) => {
    if (seen.has(p)) return; const src = readFileSync(join(ROOT, p), "utf8"); const deps = [];
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm), ...src.matchAll(/^\s*import\s+"([^"]+)"/gm), ...src.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    assert.ok(!/import\(\s*[^"'`\s]/.test(src) && !/\brequire\(/.test(src), `no computed import / require in ${p}`);
    for (const s of specs) { if (s.startsWith(".")) deps.push(normalize(join(dirname(p), s))); else ext.add(s); }
    seen.set(p, deps); for (const d of deps) { assert.ok(existsSync(join(ROOT, d)), d); visit(d); }
  };
  for (const s of starts) visit(s);
  return { files: [...seen.keys()].sort(), external: [...ext].sort() };
}
function indepDigest(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const pkgs = new Set(); const q = CLI.NATIVE_EXTERNALS.map((n) => `node_modules/${n}`);
  while (q.length) { const k = q.pop(); if (pkgs.has(k)) continue; pkgs.add(k); const e = lock.packages[k]; for (const d of Object.keys({ ...(e.dependencies || {}), ...(e.optionalDependencies || {}) })) if (lock.packages[`node_modules/${d}`]) q.push(`node_modules/${d}`); }
  const files = [...CLI.NATIVE_EXEC_SOURCES];
  const walk = (rel) => { for (const d of readdirSync(join(root, rel), { withFileTypes: true })) { const p = `${rel}/${d.name}`; if (d.isDirectory()) walk(p); else if (d.isFile()) files.push(p); else throw new Error(`special ${p}`); } };
  for (const k of pkgs) walk(k);
  files.sort();
  const h = createHash("sha256"); h.update("e7-native-exec-closure-v1\n");
  for (const f of files) { const b = readFileSync(join(root, f)); h.update(`${f}\0${b.length}\0`); h.update(b); h.update("\0"); }
  return { digest: h.digest("hex"), files: files.length, pkgs: [...pkgs].sort() };
}

test("N1 NATIVE EXECUTION CLOSURE: literal list = independent scan of CLI + launcher ∪ RUN_PLAN_CLOSURE ∪ R1_EXECUTOR_CLOSURE ∪ manifests; externals = scanned bare specifiers; CLI digest = independent digest; no self-embedded digest; the G1 30-path closure is NOT it", async () => {
  const g = scan(["scripts/e7-connected/run-plan-cli-main.mjs", "scripts/e7-connected/run-r1-launcher.mjs"]);
  const want = [...new Set([...g.files, ...RUN_PLAN_CLOSURE, ...R.R1_EXECUTOR_CLOSURE, "package.json", "package-lock.json"])].sort();
  assert.deepEqual([...CLI.NATIVE_EXEC_SOURCES], want);
  assert.deepEqual([...CLI.NATIVE_EXTERNALS], g.external.filter((x) => !x.startsWith("node:")));
  const entries = await CLI.readNativeClosure(ROOT, FS_CONSTANTS);
  assert.ok(entries); const ind = indepDigest(ROOT);
  assert.equal(entries.length, ind.files); assert.equal(await CLI.nativeClosureDigest(entries), ind.digest);
  console.log(`# N1 native closure: ${CLI.NATIVE_EXEC_SOURCES.length} sources + ${ind.files - CLI.NATIVE_EXEC_SOURCES.length} dependency files (${ind.pkgs.length} packages) → ${ind.digest}`);
  for (const f of CLI.NATIVE_EXEC_SOURCES) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes(ind.digest), `${f} embeds no digest`);
  assert.ok(R.R1_EXECUTOR_CLOSURE.length === 30 && CLI.NATIVE_EXEC_SOURCES.length > R.R1_EXECUTOR_CLOSURE.length);
  for (const f of ["scripts/e7-connected/run-r1-launcher.mjs", "scripts/e7-connected/run-core-abort-v2.mjs", "scripts/e7-connected/run-journal-file-v2.mjs", "scripts/e7-connected/db-credential-file.mjs",
    "scripts/e7-connected/http-transports.mjs", "scripts/e7-connected/real-exchange.mjs", "lib/booking-db/pool.js", "lib/booking-db/reservation-worker.js", "lib/booking-db/compensation-worker.js"])
    assert.ok(CLI.NATIVE_EXEC_SOURCES.includes(f) && !R.R1_EXECUTOR_CLOSURE.includes(f), `${f}: in the native closure, not in the G1-only closure`);
});

test("N2 exact execute grammar (pure) + REAL child boot: incomplete / repeated / untyped / duplicate-path execute → USAGE exit 2 with ZERO process-setting reads and no fs call by the CLI", () => {
  const d = tmp("g3b-g-"); const p = (n) => join(d, n);
  const full = () => ["execute", "--package", p("a"), "--plan", p("b"), "--expect-package-hash", "a".repeat(64), "--expect-executor-digest", "b".repeat(64), "--expect-native-digest", "c".repeat(64),
    "--intent", "00000000-0000-4000-8000-0000000000f1", "--provider-credentials", p("c"), "--db-app", p("d"), "--db-report", p("e"), "--db-ca", "none", "--journal-dir", p("f"), "--head-dir", p("g"),
    "--stripe-api-version", "2099-01-01.synthetic"];
  assert.ok(CLI.executeFlagsOf(full()));
  const bad = [["execute"], full().slice(0, -2), [...full(), "--x", "y"], full().map((t, i) => (i === 5 ? "a".repeat(64) : t)), full().map((t) => (t === p("b") ? p("a") : t)),
    full().map((t) => (t === "--intent" ? "--plan" : t)), full().map((t) => (t === p("c") ? "relative/c" : t)), full().map((t) => (t === "2099-01-01.synthetic" ? "latest" : t)),
    full().map((t) => (t === "none" ? "NONE" : t)), full().map((t) => (t === "a".repeat(64) ? "A".repeat(64) : t))];
  for (const b of bad) assert.equal(CLI.executeFlagsOf(b), null, JSON.stringify(b).slice(0, 120));
  for (const args of [["execute"], full().slice(0, -2), bad[4]]) {
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(PROC_TRACER).href, "--import", pathToFileURL(FS_TRACER).href, CLI_PATH, ...args], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    const out = JSON.parse(r.stdout.trim());
    assert.deepEqual([r.status, out.outcome], [2, "USAGE"], r.stderr);
    assert.deepEqual(JSON.parse(/^E7PROC (.*)$/m.exec(r.stderr)[1]), [], "no process-setting read");
    const tr = JSON.parse(/^E7TRACE (.*)$/m.exec(r.stderr)[1]);
    assert.deepEqual(tr.calls, [`fs.openSync ${pathToFileURL(CLI_PATH).href}`], "only Node's own entry-file load");
  }
});

// ---- child-process boot over REAL files: a valid bound package for a SYNTHETIC intent (no DB needed until after ingress) -------------
const MIN = 60_000; const DAY = 86_400_000; const iso = (t) => new Date(t).toISOString(); const ymd = (t) => iso(t).slice(0, 10);
const ENV = { schema: "e7-probe-env-snapshot-v1", nodeVersion: process.versions.node, platform: process.platform, execArgvCount: 0, uidAvailable: true,
  present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
    "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) };
function fixture(root = ROOT) {
  const now = Date.now(); const u8 = (p) => new Uint8Array(readFileSync(join(root, p)));
  const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) })); const EXEC = R.R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
  const plan = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-g3b-boot", createdAt: iso(now - MIN), baseline: { repoCommit: "0807e3048e419b3405c649f445760b1b47f331c3", sourceDigest: sourceDigestV1(FOUND) },
    environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" }, db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" }, phases: { capture: false, recording: false, testAbortAfterReservation: true },
    allowedOps: [...ALLOWED_OPS], checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 }, stayRules: { minLeadDays: 7, maxNights: 7 },
    exclusions: JSON.parse(JSON.stringify(HISTORICAL_EXCLUSIONS)), binding: { intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "MV-SYN0001", paymentIntentId: "pi_SYNTHETIC0000f1",
      stay: { arrival: ymd(now + 30 * DAY), departure: ymd(now + 32 * DAY), guests: 2 }, amountMinor: 23000, rateBps: 1000, quote: { totalMinor: 23000, currency: "USD", quotedAt: iso(now - 2 * MIN) }, authorizedAt: iso(now - MIN) } };
  const planBytes = new TextEncoder().encode(`${canonicalJson(plan)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV, planClock: now - 30_000 });
  assert.ok(built.ok, built.code);
  const d = tmp("g3b-boot-");
  const f = { package: put(d, "package.json", `${canonicalJson(built.package)}\n`), plan: put(d, "plan.json", planBytes), provider: put(d, "provider.json", JSON.stringify({ hostawayToken: HTOKEN, stripeTestKey: SKEY })),
    app: put(d, "app.json", JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_app", connectionString: `postgresql://u_app:${CANARY}@db.synthetic.invalid:5432/postgres` })),
    report: put(d, "report.json", JSON.stringify({ schema: "e7-db-login-v1", role: "mv_booking_report", connectionString: `postgresql://u_rep:${CANARY}@db.synthetic.invalid:5432/postgres` })),
    jd: join(d, "j"), hd: join(d, "h") };
  mkdirSync(f.jd, { mode: 0o700 }); mkdirSync(f.hd, { mode: 0o700 });
  return { f, built, executorDigest: R.executorDigestR1(EXEC), intent: plan.binding.intentId };
}
const argsOf = (x, over = {}) => { const a = { "--package": x.f.package, "--plan": x.f.plan, "--expect-package-hash": x.built.packageHash, "--expect-executor-digest": x.executorDigest,
  "--expect-native-digest": indepDigest(ROOT).digest, "--intent": x.intent, "--provider-credentials": x.f.provider, "--db-app": x.f.app, "--db-report": x.f.report, "--db-ca": "none",
  "--journal-dir": x.f.jd, "--head-dir": x.f.hd, "--stripe-api-version": "2099-01-01.synthetic", ...over }; return ["execute", ...Object.entries(a).flat()]; };
const boot = (args, { cli = CLI_PATH, trace = false } = {}) => {
  const r = spawnSync(process.execPath, [...(trace ? ["--import", pathToFileURL(FS_TRACER).href] : []), cli, ...args], { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 60_000 });
  for (const bad of [CANARY, HTOKEN, SKEY]) { assert.ok(!r.stdout.includes(bad) && !r.stderr.includes(bad), `no canary in stdout / stderr (${bad.slice(0, 6)}…)`); }
  return { status: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)), stderr: r.stderr, trace: trace ? JSON.parse(/^E7TRACE (.*)$/m.exec(r.stderr)[1]) : null };
};

test("N3 REAL child boot, native closure refusals BEFORE any non-built-in import: wrong expected digest; a tampered SOURCE copy; a tampered DEPENDENCY copy; a symlink inside a dependency package — launcher never resolved", () => {
  const x = fixture();
  { const r = boot(argsOf(x, { "--expect-native-digest": "0".repeat(64) }), { trace: true });
    assert.deepEqual([r.status, r.out.outcome, r.out.code, r.out.nativeDigest], [4, "NATIVE_CLOSURE_REFUSED", "NATIVE_DIGEST_MISMATCH", indepDigest(ROOT).digest]);
    assert.ok(!r.trace.resolved.some((s) => /run-r1-launcher|probe-cli-main|run-core|pg/.test(s)), `nothing sensitive resolved: ${r.trace.resolved}`);
    assert.ok(!r.trace.calls.some((c) => c.includes(x.f.provider) || c.includes(x.f.app)), "no owner file touched"); }
  // a COPY of the tree (labelled TEST-ONLY): tamper one closure source, then one dependency file, then add a symlink to a dependency package
  const tree = tmp("g3b-tree-");
  for (const top of ["scripts", "lib", "package.json", "package-lock.json"]) cpSync(join(ROOT, top), join(tree, top), { recursive: true });
  mkdirSync(join(tree, "node_modules"));
  for (const k of indepDigest(ROOT).pkgs) cpSync(join(ROOT, k), join(tree, k), { recursive: true, dereference: true });
  const cli = join(tree, "scripts/e7-connected/run-plan-cli-main.mjs"); const good = indepDigest(tree).digest;
  assert.equal(good, indepDigest(ROOT).digest, "an exact copy has the same native digest");
  writeFileSync(join(tree, "lib/booking-db/pool.js"), `${readFileSync(join(ROOT, "lib/booking-db/pool.js"), "utf8")}\n// tampered\n`);
  { const r = boot(argsOf(x, { "--expect-native-digest": good }), { cli }); assert.deepEqual([r.out.outcome, r.out.code], ["NATIVE_CLOSURE_REFUSED", "NATIVE_DIGEST_MISMATCH"]); }
  writeFileSync(join(tree, "lib/booking-db/pool.js"), readFileSync(join(ROOT, "lib/booking-db/pool.js")));
  writeFileSync(join(tree, "node_modules/pg/package.json"), `${readFileSync(join(ROOT, "node_modules/pg/package.json"), "utf8")} `);
  { const r = boot(argsOf(x, { "--expect-native-digest": good }), { cli }); assert.deepEqual([r.out.outcome, r.out.code], ["NATIVE_CLOSURE_REFUSED", "NATIVE_DIGEST_MISMATCH"]); }
  writeFileSync(join(tree, "node_modules/pg/package.json"), readFileSync(join(ROOT, "node_modules/pg/package.json")));
  symlinkSync("/etc/hostname", join(tree, "node_modules/pg/evil-link"));
  { const r = boot(argsOf(x, { "--expect-native-digest": good }), { cli }); assert.deepEqual([r.out.outcome, r.out.code], ["NATIVE_CLOSURE_REFUSED", "NATIVE_CLOSURE_UNREADABLE"]); }
});

test("N4 REAL child boot past verification, refusals in the reviewed order: package hash / executor pin / intent before owner files; provider / login files before pools; remote DB without CA → POOL_CONFIG_REFUSED (no DNS / connect); nothing secret echoed", () => {
  const x = fixture(); const missing = join(dirname(x.f.provider), "missing-owner-file.json");   // an existing owner dir (a missing PARENT is CRED_IO, diagnosed in FIRST TAP)
  const cases = [
    ["package hash", { "--expect-package-hash": "1".repeat(64), "--provider-credentials": missing }, { stage: "package", code: "R1_PACKAGE_HASH_MISMATCH" }],
    ["executor pin", { "--expect-executor-digest": "1".repeat(64), "--provider-credentials": missing }, { stage: "package", code: "R1_EXECUTOR_DIGEST_MISMATCH" }],
    ["intent", { "--intent": "00000000-0000-4000-8000-0000000000ab", "--provider-credentials": missing }, { stage: "package", code: "INTENT_MISMATCH" }],
    ["provider missing", { "--provider-credentials": missing }, { stage: "provider-credentials", code: "CRED_MISSING" }],
    ["db login missing", { "--db-app": missing }, { stage: "db-login-app", code: "CRED_MISSING" }],
    ["remote without CA", {}, { stage: "pool", code: "POOL_CONFIG_REFUSED" }]
  ];
  for (const [label, over, want] of cases) {
    const r = boot(argsOf(x, over));
    assert.deepEqual([r.status, r.out.outcome, r.out.result.refused], [4, "EXECUTE_REFUSED", want], `${label}: ${JSON.stringify(r.out)}`);
    assert.equal(r.out.result.run, null);
  }
  assert.deepEqual(readdirSync(x.f.jd), [], "no journal created by any refusal");
});
