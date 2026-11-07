// E7 M2-G1 — pure R1 binder (OFFLINE; contract claude/e7-run-real-r1.md §1–§2, §6). Every plan, clock, env snapshot and id is SYNTHETIC
// (labelled) except the historical exclusion ids the planner requires (refused, never used). No DB, provider, network, credential.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as R from "../scripts/e7-connected/run-binding-r1.mjs";
import { buildRunPackageV1, sourceDigestV1, RUN_PLAN_CLOSURE, HISTORICAL_EXCLUSIONS, ALLOWED_OPS } from "../scripts/e7-connected/run-plan-v1.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";
import { bindManifestV2 } from "../scripts/e7-connected/run-journal-memory-v2.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline R1 binder suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0); });

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const enc = new TextEncoder();
const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sha = (b) => createHash("sha256").update(b).digest("hex");
// SYNTHETIC clock / plan
const NOW = Date.parse("2027-02-01T03:00:00.000Z"); const MIN = 60_000;
const at = (ms) => new Date(NOW - ms).toISOString();
const FOUND = RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const EXEC = R.R1_EXECUTOR_CLOSURE.map((path) => ({ path, bytes: u8(path) }));
const FOUND_DIGEST = sourceDigestV1(FOUND);                    // the declared foundation digest of THIS snapshot (computed, never a constant)
/** the executor digest, framed HERE independently (contract §2 step 9) */
const indepDigest = (entries) => sha(Buffer.concat([Buffer.from("e7-run-executor-source-r1\n"), ...entries.flatMap((e) => [Buffer.from(`${e.path}\0${e.bytes.length}\0`), Buffer.from(e.bytes), Buffer.from([0])])]));
const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: Object.fromEntries(["NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "NODE_DEBUG", "NODE_DEBUG_NATIVE", "SSLKEYLOGFILE",
    "OPENSSL_CONF", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"].map((k) => [k, false])) });
const plan = (over = (p) => p) => {
  const p = { version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-r1-0001", createdAt: at(MIN),
    baseline: { repoCommit: "58a88f691ac88dcb260cdf407a73785cd96949cd", sourceDigest: null },
    environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" },
      db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
    listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" },
    phases: { capture: false, recording: false, testAbortAfterReservation: true }, allowedOps: [...ALLOWED_OPS],
    checkpoints: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"],
    deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 }, stayRules: { minLeadDays: 7, maxNights: 7 }, exclusions: clone(HISTORICAL_EXCLUSIONS),
    binding: { intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "MV-SYN0001", paymentIntentId: "pi_SYNTHETIC0000f1",
      stay: { arrival: "2027-03-10", departure: "2027-03-12", guests: 2 }, amountMinor: 23000, rateBps: 1000,
      quote: { totalMinor: 23000, currency: "USD", quotedAt: at(10 * MIN) }, authorizedAt: at(5 * MIN) } };
  over(p);
  return p;
};
/** a full valid fixture: plan bytes, package bytes, expected pins */
function fixture(over, { clock = NOW } = {}) {
  const p = plan(over); if (p.baseline.sourceDigest === null) p.baseline.sourceDigest = FOUND_DIGEST;
  const planBytes = enc.encode(`${canonicalJson(p)}\n`);
  const built = buildRunPackageV1({ planBytes, sourceEntries: FOUND, envSnapshot: ENV(), planClock: clock });
  assert.ok(built.ok, `fixture build ${built.code}`);
  return { plan: p, built, input: { packageBytes: enc.encode(`${canonicalJson(built.package)}\n`), planBytes, foundationSources: FOUND, executorSources: EXEC, envSnapshot: ENV(),
    expected: { packageHash: built.packageHash, executorDigest: indepDigest(EXEC) }, execClock: clock } };
}
const bind = (inp) => R.bindRunPackageR1(inp);

test("B1 valid → evidence-only binding; package tamper / recompute mismatch / pin mismatch / UNBOUND refused", () => {
  const fx = fixture();
  const r = bind(fx.input);
  assert.equal(r.ok, true, r.code);
  const b = r.binding;
  assert.equal(b.schema, "e7-run-binding-r1"); assert.equal(b.nature, "R1_BINDING_EVIDENCE_ONLY"); assert.equal(b.executable, false);
  assert.ok(Object.values(b.permissions).every((v) => v === false) && Object.keys(b.permissions).length === 7);
  assert.equal(b.identity.manifestVersion, "e7-run-package-r1"); assert.equal(b.identity.manifestHash, fx.built.packageHash);
  assert.equal(b.packageHash, fx.built.packageHash); assert.equal(b.foundationDigest, FOUND_DIGEST); assert.equal(b.executorDigest, indepDigest(EXEC));
  assert.equal(b.scope.paymentIntentId, "pi_SYNTHETIC0000f1"); assert.equal(b.scope.expectedRef, "MV-SYN0001"); assert.deepEqual(clone(b.exclusions), clone(HISTORICAL_EXCLUSIONS));
  assert.ok(Object.isFrozen(b) && Object.isFrozen(b.scope) && Object.isFrozen(b.exclusions.runs[0]));
  // tamper 1 byte of the package
  const t = new Uint8Array(fx.input.packageBytes); t[t.length - 3] ^= 1;
  assert.ok(["R1_PACKAGE_BYTES_INVALID", "R1_PACKAGE_MISMATCH", "R1_PACKAGE_INVALID"].includes(bind({ ...fx.input, packageBytes: t }).code));
  // a canonical, internally-valid package for a DIFFERENT plan → mismatch with the supplied plan bytes
  const other = fixture((p) => { p.runId = "synthetic-r1-0002"; });
  assert.equal(bind({ ...fx.input, packageBytes: other.input.packageBytes }).code, "R1_PACKAGE_MISMATCH");
  assert.equal(bind({ ...fx.input, planBytes: other.input.planBytes }).code, "R1_PACKAGE_MISMATCH");
  assert.equal(bind({ ...fx.input, expected: { ...fx.input.expected, packageHash: "0".repeat(64) } }).code, "R1_PACKAGE_HASH_MISMATCH");
  // non-canonical package bytes (pretty) and a schema-changed package
  assert.equal(bind({ ...fx.input, packageBytes: enc.encode(`${JSON.stringify(fx.built.package, null, 1)}\n`) }).code, "R1_PACKAGE_BYTES_INVALID");
  const execTrue = enc.encode(`${canonicalJson({ ...clone(fx.built.package), executable: true })}\n`);
  assert.equal(bind({ ...fx.input, packageBytes: execTrue }).code, "R1_PACKAGE_INVALID");
  // UNBOUND
  const u = fixture((p) => { p.binding = null; });
  assert.equal(bind(u.input).code, "R1_UNBOUND");
  // recompute refused (env snapshot that the accepted builder refuses)
  assert.equal(bind({ ...fx.input, envSnapshot: { ...ENV(), nodeVersion: "20.0.0" } }).code, "R1_RECOMPUTE_REFUSED");
});

test("B2 clock: invalid / before package refused; separate freshness at execClock with ±1 ms boundary", () => {
  const fx = fixture();
  for (const c of [NaN, 1.5, "1", 0, -1, 2 ** 53, new Number(NOW)]) assert.equal(bind({ ...fx.input, execClock: c }).code, "R1_CLOCK_INVALID", String(c));
  assert.equal(bind({ ...fx.input, execClock: NOW - 1 }).code, "R1_CLOCK_BEFORE_PACKAGE");
  // quote quotedAt = NOW-10 min, cap 30 min → valid through NOW+20 min exactly; +1 ms stale (re-measured at exec, not at build)
  assert.equal(bind({ ...fx.input, execClock: NOW + 20 * MIN }).ok, true);
  assert.equal(bind({ ...fx.input, execClock: NOW + 20 * MIN + 1 }).code, "R1_STALE_AT_EXEC");
  assert.equal(bind({ ...fx.input, execClock: NOW + 20 * MIN - 1 }).ok, true);
});

test("B3 stricter accepted rules: plan-valid ref without MV- and rate > MAX_RATE_BPS refused", () => {
  assert.equal(bind(fixture((p) => { p.binding.expectedRef = "SYN-REF-0001"; }).input).code, "R1_REF_NOT_ACCEPTED");
  assert.equal(bind(fixture((p) => { p.binding.expectedRef = "MV-ABC12"; }).input).code, "R1_REF_NOT_ACCEPTED");
  assert.equal(bind(fixture((p) => { p.binding.rateBps = 5001; }).input).code, "R1_RATE_NOT_ACCEPTED");
  assert.equal(bind(fixture((p) => { p.binding.rateBps = 5000; }).input).ok, true);
  // parity of the stricter ref rule with the accepted text
  for (const f of ["scripts/e7-connected/run-manifest-v2.mjs", "scripts/e7-connected/executor-adapters.mjs", "scripts/e7-connected/run-facts.mjs"])
    assert.ok(readFileSync(join(ROOT, f), "utf8").includes("REF_RE = /^MV-[A-Z0-9]{6,10}$/;"), f);
  assert.ok(readFileSync(join(ROOT, "lib/direct-pricing.js"), "utf8").includes("export const MAX_RATE_BPS = 5000;"));
});

function scan(starts) {
  const seen = new Map(); const ext = new Set();
  const visit = (p) => {
    if (seen.has(p)) return; const src = readFileSync(join(ROOT, p), "utf8"); const deps = [];
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm), ...src.matchAll(/^\s*import\s+"([^"]+)"/gm), ...src.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    assert.ok(!/import\(\s*[^"'`\s]/.test(src) && !/\brequire\(/.test(src), p);
    for (const s of specs) { if (s.startsWith(".")) deps.push(normalize(join(dirname(p), s))); else ext.add(s); }
    seen.set(p, deps); for (const d of deps) { assert.ok(existsSync(join(ROOT, d)), d); visit(d); }
  };
  for (const s of starts) visit(s);
  return { files: [...seen.keys()].sort(), external: [...ext].sort() };
}

test("B4 executor closure = scanned G1 roots + manifests; tamper / missing / extra / reorder / overlap mismatch refused; no self-hash", () => {
  const g = scan(["scripts/e7-connected/run-binding-r1.mjs", "scripts/e7-connected/run-preflight-r1.mjs"]);
  assert.deepEqual([...R.R1_EXECUTOR_CLOSURE], [...g.files, "package.json", "package-lock.json"].sort());
  assert.deepEqual(g.external, ["node:crypto", "node:util"]);
  for (const p of R.R1_EXECUTOR_CLOSURE) { const st = lstatSync(join(ROOT, p)); assert.ok(st.isFile() && !st.isSymbolicLink(), p); }
  assert.ok(!R.R1_EXECUTOR_CLOSURE.some((p) => /run-core|run-test-abort|journal|worker|operator|transport|exchange|credential|pool\.js/.test(p)), "G1 code only");
  const fx = fixture();
  assert.equal(R.executorDigestR1(EXEC), indepDigest(EXEC));
  const mod = (fn) => { const e = EXEC.map((x) => ({ path: x.path, bytes: new Uint8Array(x.bytes) })); fn(e); return e; };
  // tamper a NON-overlapping executor file → digest mismatch (pinned digest is the clean one)
  const nonOverlap = R.R1_EXECUTOR_CLOSURE.findIndex((p) => !RUN_PLAN_CLOSURE.includes(p));
  assert.ok(nonOverlap >= 0);
  assert.equal(bind({ ...fx.input, executorSources: mod((e) => { e[nonOverlap].bytes[0] ^= 1; }) }).code, "R1_EXECUTOR_DIGEST_MISMATCH");
  for (const [k, s] of Object.entries({ missing: EXEC.slice(1), extra: [...EXEC, { path: "x.js", bytes: enc.encode("x") }], reorder: [EXEC[1], EXEC[0], ...EXEC.slice(2)],
    renamed: mod((e) => { e[0] = { path: `./${e[0].path}`, bytes: e[0].bytes }; }), buffer: mod((e) => { e[0] = { path: e[0].path, bytes: Buffer.from(e[0].bytes) }; }),
    proxy: new Proxy(EXEC, {}), empty: [] }))
    assert.equal(bind({ ...fx.input, executorSources: s }).code, "R1_SOURCES_INVALID", k);
  // OVERLAP: an overlapping path with different bytes refuses even when the executor pin was made over that very snapshot
  const overlapIdx = R.R1_EXECUTOR_CLOSURE.indexOf("scripts/e7-connected/run-plan-v1.mjs");
  const diff = mod((e) => { e[overlapIdx].bytes[0] ^= 1; });
  assert.equal(bind({ ...fx.input, executorSources: diff, expected: { ...fx.input.expected, executorDigest: indepDigest(diff) } }).code, "R1_SNAPSHOT_OVERLAP_MISMATCH");
  // a foundation-only path tampered → the accepted recompute refuses (foundation digest no longer the plan's)
  const fOnly = RUN_PLAN_CLOSURE.findIndex((p) => !R.R1_EXECUTOR_CLOSURE.includes(p));
  const ft = FOUND.map((x, i) => ({ path: x.path, bytes: i === fOnly ? (() => { const b = new Uint8Array(x.bytes); b[0] ^= 1; return b; })() : x.bytes }));
  assert.equal(bind({ ...fx.input, foundationSources: ft }).code, "R1_RECOMPUTE_REFUSED");
  // no self-hash: neither module embeds the current digests
  for (const f of ["scripts/e7-connected/run-binding-r1.mjs", "scripts/e7-connected/run-preflight-r1.mjs"]) {
    const t = readFileSync(join(ROOT, f), "utf8"); assert.ok(!t.includes(indepDigest(EXEC)) && !t.includes(FOUND_DIGEST), f);
  }
});

test("B5 R1 ⇄ v2 cross-refusal; hostile input (getter / proxy / __proto__ / extra key) refused with zero getter calls; binding frozen", () => {
  const fx = fixture(); const b = bind(fx.input).binding;
  assert.equal(validateRunManifestV2(b).ok, false);
  assert.equal(bindManifestV2(b).ok, false);
  assert.equal(validateRunManifestV2({ ...clone(b), version: "e7-run-manifest-v2" }).ok, false);
  // a v2-shaped manifest as package bytes → refused
  const v2ish = enc.encode(`${canonicalJson({ version: "e7-run-manifest-v2", synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" } })}\n`);
  assert.equal(bind({ ...fx.input, packageBytes: v2ish }).code, "R1_PACKAGE_INVALID");
  // the R1 identity never equals a v2 identity for the same values
  assert.notEqual(b.identity.manifestVersion, "e7-run-manifest-v2");
  let ran = 0;
  const g = { ...fx.input }; Object.defineProperty(g, "execClock", { get() { ran++; return NOW; }, enumerable: true });
  const ex = { ...fx.input, expected: Object.defineProperty({ executorDigest: fx.input.expected.executorDigest }, "packageHash", { get() { ran++; return "0".repeat(64); }, enumerable: true }) };
  const pr = Object.defineProperty({ ...fx.input }, "__proto__", { value: null, enumerable: true, writable: true, configurable: true });
  const cases = { getter: g, expectedGetter: ex, proxy: new Proxy(fx.input, {}), protoKey: pr, extra: { ...fx.input, more: 1 }, missing: (({ execClock, ...x }) => x)(fx.input),
    nul: null, arr: [], symbol: Object.assign({ ...fx.input }, { [Symbol("s")]: 1 }), boxedExpected: { ...fx.input, expected: { packageHash: new String(fx.input.expected.packageHash), executorDigest: fx.input.expected.executorDigest } },
    boxedClock: { ...fx.input, execClock: new Number(NOW) }, inheritedExpected: { ...fx.input, expected: Object.assign(Object.create({ inherited: 1 }), fx.input.expected) } };
  for (const [k, v] of Object.entries(cases)) { const r = bind(v); assert.equal(r.ok, false, k); assert.ok(R.BINDER_CODES.includes(r.code), k); }
  assert.equal(bind({ ...fx.input, expected: { packageHash: "X".repeat(64), executorDigest: fx.input.expected.executorDigest } }).code, "R1_EXPECTED_INVALID");
  assert.equal(ran, 0, "no getter executed");
  // caller mutation after the (synchronous) bind does not reach the frozen binding
  const fx2 = fixture(); const r2 = bind(fx2.input); fx2.input.packageBytes.fill(0); fx2.input.foundationSources[0].bytes.fill(0);
  assert.equal(r2.binding.packageHash, fx2.built.packageHash); assert.ok(Object.isFrozen(r2) && Object.isFrozen(r2.binding.identity));
  assert.ok(R.BINDER_CODES.length === new Set(R.BINDER_CODES).size);
});

test("B6 import boundary: binder graph pure; importing binder + preflight has zero env / fetch / timer / fs side effects (child process)", () => {
  const g = scan(["scripts/e7-connected/run-binding-r1.mjs"]);
  assert.deepEqual(g.external, ["node:crypto", "node:util"]);
  assert.ok(!g.files.some((f) => /booking-db|worker|operator|journal|transport|exchange|credential|run-core|hostaway|server-pricer/.test(f)), "binder imports only pure modules");
  const forbidden = /\bprocess\.|\bfetch\(|setTimeout|setInterval|setImmediate|\beval\(|new Function|node:fs|node:net|node:https?|node:child_process|Date\.now\(|new Date\(\)/;
  for (const f of ["scripts/e7-connected/run-binding-r1.mjs", "scripts/e7-connected/run-preflight-r1.mjs"]) {
    const src = readFileSync(join(ROOT, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    assert.ok(!forbidden.test(src), `${f}: ${(src.match(forbidden) || [])[0]}`);
  }
  // Node's OWN loader / util read a few env keys (WATCH_REPORT_DEPENDENCIES per module load; FORCE_COLOR from node:internal/util/colors when
  // util is first used). A faithful CONTROL module (node:util types + node:crypto + TextDecoder) establishes that set first; G1 may add NO key.
  const probe = `
    const keys = { control: new Set(), g1: new Set() }; let phase = "control"; let net = 0, tim = 0;
    const real = process.env; process.env = new Proxy(real, { get(t, k) { if (typeof k === "string") keys[phase].add(k); return t[k]; },
      has(t, k) { keys[phase].add(String(k)); return k in t; }, ownKeys(t) { keys[phase].add("<ownKeys>"); return Reflect.ownKeys(t); } });
    globalThis.fetch = () => { net++; throw new Error("x"); };
    const st = globalThis.setTimeout, si = globalThis.setInterval; globalThis.setTimeout = (...a) => { tim++; return st(...a); }; globalThis.setInterval = (...a) => { tim++; return si(...a); };
    await import("data:text/javascript," + encodeURIComponent('import { types } from "node:util"; import "node:crypto"; types.isProxy({}); new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([65])); export const x = 1;'));
    phase = "g1";
    await import(${JSON.stringify(join(ROOT, "scripts/e7-connected/run-binding-r1.mjs"))});
    await import(${JSON.stringify(join(ROOT, "scripts/e7-connected/run-preflight-r1.mjs"))});
    process.env = real;
    const extra = [...keys.g1].filter((k) => !keys.control.has(k));
    console.log(JSON.stringify({ extra, net, tim, control: [...keys.control].sort(), g1: [...keys.g1].sort() }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  assert.deepEqual([out.extra, out.net, out.tim], [[], 0, 0], JSON.stringify(out));
  // and specifically no application / credential / provider / DB key is touched at import
  assert.ok(!out.g1.some((k) => /HOSTAWAY|STRIPE|DATABASE|PG|VERCEL|MV_|DIRECT_|SECRET|KEY|TOKEN/.test(k)), JSON.stringify(out.g1));
});
