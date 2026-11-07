// E7 M2-F — plan-only run package + inspect-only command (OFFLINE unit tests; contract claude/e7-run-plan-v1.md; root review 48d9e328).
// Every plan, env snapshot, clock, account label and id below is SYNTHETIC and labelled as such, EXCEPT the historical exclusion ids, which are
// copied literally from the accepted ledger (they are refused, never used). No DB, no provider, no network, no credential, no PG.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../scripts/e7-connected/run-plan-v1.mjs";
import { runPlanCommand, CLI_RESULT_SCHEMA, OUTCOMES, CODES } from "../scripts/e7-connected/run-plan-command.mjs";
import { canonicalJson } from "../scripts/e7-connected/run-manifest.mjs";
import { validateRunManifest } from "../scripts/e7-connected/run-manifest.mjs";
import { validateRunManifestV2 } from "../scripts/e7-connected/run-manifest-v2.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline run-plan suite)"); };
after(() => { globalThis.fetch = realFetch; assert.equal(netAttempts, 0, "no network attempt"); });

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const u8 = (p) => new Uint8Array(readFileSync(join(ROOT, p)));
const enc = new TextEncoder();
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------------------------------
// fixtures (SYNTHETIC)
// SYNTHETIC clock: 2027-02-01T03:00Z is 2027-01-31 in America/Mazatlan (UTC-7) — used to prove the lead-day check uses the listing zone.
const NOW = Date.parse("2027-02-01T03:00:00.000Z");
const at = (msBeforeNow) => new Date(NOW - msBeforeNow).toISOString();
const MIN = 60_000; const HOUR = 3_600_000;
const SOURCES = P.RUN_PLAN_CLOSURE.map((path) => ({ path, bytes: u8(path) }));      // caller snapshot of the CURRENT working-tree bytes
const SOURCE_DIGEST = P.sourceDigestV1(SOURCES);
/** the exclusion block, typed LITERALLY from the accepted ledger (independent of the module constant) */
const LEDGER_EXCLUSIONS = {
  protectedReservationIds: ["70636076", "71045356", "71072615", "71081885"],
  runs: [
    { label: "run1", intentId: "b312e325-e6b5-498c-80b5-b91ce5bb3df2", paymentIntentId: null, reservationId: null },
    { label: "run2", intentId: "48b59c0d-1c8c-4f32-ad91-08dbab1e8e3c", paymentIntentId: null, reservationId: null },
    { label: "run3", intentId: "cc53bc11-565d-4e9b-8be1-95f3febc8a39", paymentIntentId: "pi_3UYqhH2B9LTneQgw1Q0IoYtz", reservationId: null }
  ],
  otherPaymentIntentIds: ["pi_3UYUIm2B9LTneQgw0mGFQdwG"]
};
const OPS = ["hostaway.lookup_by_ref", "hostaway.get_reservation_created", "hostaway.get_listing", "hostaway.get_calendar", "hostaway.price_details",
  "hostaway.create_reservation", "hostaway.cancel_reservation_created", "stripe.accounts.retrieve", "stripe.paymentIntents.retrieve_bound", "stripe.paymentIntents.cancel_bound"];
const CK = { disconnected: ["CALENDAR_BASELINE", "CALENDAR_BLOCKED", "CALENDAR_REOPENED"], airbnb: ["CALENDAR_BASELINE", "AIRBNB_BLOCKED", "AIRBNB_REOPENED"] };
const binding = () => ({
  intentId: "00000000-0000-4000-8000-0000000000f1", expectedRef: "SYN-REF-0001", paymentIntentId: "pi_SYNTHETIC0000f1",
  stay: { arrival: "2027-03-10", departure: "2027-03-12", guests: 2 }, amountMinor: 23000, rateBps: 1000,
  quote: { totalMinor: 23000, currency: "USD", quotedAt: at(10 * MIN) }, authorizedAt: at(5 * MIN)
});
/** a VALID synthetic plan; `bind=false` → UNBOUND */
const plan = (bind = true) => ({
  version: "e7-run-plan-v1", kind: "reservation-test-abort-v1", runId: "synthetic-plan-0001", createdAt: at(1 * MIN),
  baseline: { repoCommit: "980094454410b4609c67086a045608b576484d8d", sourceDigest: SOURCE_DIGEST },
  environment: { stripe: { mode: "test", accountId: "acct_SYNTHETIC0001" }, hostaway: { accountRef: "synthetic-hostaway", clientSnapshotId: "synthetic-client-1" },
    db: { instanceEnvironment: "test", appRole: "mv_booking_app", reportRole: "mv_booking_report" } },
  listing: { id: 606998, currency: "USD", refFieldId: 777009, connection: "disconnected", timeZone: "America/Mazatlan" },
  phases: { capture: false, recording: false, testAbortAfterReservation: true },
  allowedOps: [...OPS], checkpoints: [...CK.disconnected],
  deadlines: { quoteMaxAgeMinutes: 30, authorizationMaxAgeHours: 24 }, stayRules: { minLeadDays: 7, maxNights: 7 },
  exclusions: clone(LEDGER_EXCLUSIONS), binding: bind ? binding() : null
});
const bytesOf = (v) => enc.encode(`${canonicalJson(v)}\n`);
/** SYNTHETIC env snapshot (labelled): not read from this process */
const ENV = () => ({ schema: "e7-probe-env-snapshot-v1", nodeVersion: "22.22.0", platform: "linux", execArgvCount: 0, uidAvailable: true,
  present: { NODE_OPTIONS: false, NODE_TLS_REJECT_UNAUTHORIZED: false, NODE_EXTRA_CA_CERTS: false, NODE_USE_ENV_PROXY: false, NODE_DEBUG: false,
    NODE_DEBUG_NATIVE: false, SSLKEYLOGFILE: false, OPENSSL_CONF: false, HTTPS_PROXY: false, HTTP_PROXY: false, NO_PROXY: false, https_proxy: false,
    http_proxy: false, no_proxy: false } });
const V = (p, clock = NOW) => P.validateRunPlanV1(p, { planClock: clock });
const code = (p, clock) => { const r = V(p, clock); return r.ok ? "OK" : r.code; };
const mut = (f, bind = true) => { const p = plan(bind); f(p); return p; };
const build = (over = {}) => P.buildRunPackageV1({ planBytes: bytesOf(plan()), sourceEntries: SOURCES, envSnapshot: ENV(), planClock: NOW, ...over });
const deps = (over = {}) => ({ envSnapshot: ENV(), planClock: () => NOW, readPlanFile: async () => bytesOf(plan()), readSourceFiles: async () => SOURCES, ...over });

// ---------------------------------------------------------------------------------------------------------------------------------------
test("T1 hash domains: independent fixed vectors (incl. NUL bytes and lengths), domain separation, unambiguous source framing", () => {
  // vectors computed independently (python hashlib) from the literal framings in contract §1
  assert.equal(P.planHashV1({ a: 1, b: "x" }), "7db95db1e738e1498c3036dc62468ac8c57e29e8f3ae9544034b7cad30ccf230");
  assert.equal(P.packageHashV1({ a: 1, b: "x" }), "38ecb223d1e4e1e31e688ce641efa1019c558e91d037b0732e63571b792f642d");
  const toy = [{ path: "a.txt", bytes: new Uint8Array([0x00, 0x41, 0x00]) }, { path: "b/c.js", bytes: new Uint8Array([0xff]) }];
  assert.equal(P.sourceDigestV1(toy), "41dbd04d9b924daaefda65a6df11be1896bc497b48ee4b6645f4f97c5c6032f9");
  // the same vector rebuilt here byte by byte
  const lit = Buffer.concat([Buffer.from("e7-run-plan-source-v1\n"), Buffer.from("a.txt\x003\x00"), Buffer.from([0, 0x41, 0]), Buffer.from([0]),
    Buffer.from("b/c.js\x001\x00"), Buffer.from([0xff]), Buffer.from([0])]);
  assert.equal(sha(lit), P.sourceDigestV1(toy));
  assert.equal(P.PLAN_HASH_PREFIX, "e7-run-plan-v1\n"); assert.equal(P.PACKAGE_HASH_PREFIX, "e7-run-package-v1\n"); assert.equal(P.SOURCE_HASH_PREFIX, "e7-run-plan-source-v1\n");
  assert.notEqual(P.planHashV1({ a: 1 }), P.packageHashV1({ a: 1 }));
  const ab = P.sourceDigestV1([{ path: "a", bytes: enc.encode("bc") }]); const a_b = P.sourceDigestV1([{ path: "ab", bytes: enc.encode("c") }]);
  assert.notEqual(ab, a_b, "path/bytes boundary is framed");
  assert.notEqual(P.sourceDigestV1([{ path: "a", bytes: enc.encode("x") }, { path: "b", bytes: enc.encode("y") }]),
    P.sourceDigestV1([{ path: "b", bytes: enc.encode("y") }, { path: "a", bytes: enc.encode("x") }]), "order is bound");
  // not circular: the module holds no expected digest of itself
  const own = readFileSync(join(ROOT, "scripts/e7-connected/run-plan-v1.mjs"), "utf8");
  assert.ok(!own.includes(SOURCE_DIGEST), "no self-hash constant");
});

// a minimal static relative-import scanner (independent of the module under test)
function scan(starts) {
  const seen = new Map(); const ext = new Set();
  const visit = (p) => {
    if (seen.has(p)) return; const src = readFileSync(join(ROOT, p), "utf8"); const deps = [];
    const specs = [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm), ...src.matchAll(/^\s*import\s+"([^"]+)"/gm), ...src.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    assert.ok(!/import\(\s*[^"'`\s]/.test(src), `no computed dynamic import in ${p}`);
    assert.ok(!/\brequire\(/.test(src), `no require in ${p}`);
    for (const s of specs) { if (s.startsWith(".")) deps.push(normalize(join(dirname(p), s))); else ext.add(s); }
    seen.set(p, deps); for (const d of deps) { assert.ok(existsSync(join(ROOT, d)), `missing ${d} (from ${p})`); visit(d); }
  };
  for (const s of starts) visit(s);
  return { files: [...seen.keys()].sort(), external: [...ext].sort() };
}

test("T2 source closure = scanned foundation roots + planner + command + package manifests; regular files; tamper and malformed entries refused", () => {
  const roots = ["run-core-abort-v2.mjs", "run-journal-file-v2.mjs", "http-transports.mjs", "real-exchange.mjs", "probe-credential-file.mjs", "probe-env-preflight.mjs",
    "probe-source-digest.mjs", "run-plan-command.mjs"].map((f) => `scripts/e7-connected/${f}`);
  const { files } = scan(roots);
  const expected = [...files, "package.json", "package-lock.json"].sort();
  assert.deepEqual([...P.RUN_PLAN_CLOSURE], expected);
  assert.deepEqual([...P.RUN_PLAN_CLOSURE], [...new Set(P.RUN_PLAN_CLOSURE)].sort(), "sorted, unique");
  assert.ok(P.RUN_PLAN_CLOSURE.includes("scripts/e7-connected/run-plan-v1.mjs") && P.RUN_PLAN_CLOSURE.includes("scripts/e7-connected/run-plan-command.mjs"));
  for (const p of P.RUN_PLAN_CLOSURE) {
    assert.ok(!p.includes("..") && !p.startsWith("/") && !p.includes("\\"), p);
    const st = lstatSync(join(ROOT, p)); assert.ok(st.isFile() && !st.isSymbolicLink(), `${p} regular file`);
    assert.ok(st.size >= 1 && st.size <= P.MAX_SOURCE_FILE_BYTES, `${p} size`);
    if (!p.endsWith(".json")) assert.ok(!/readFileSync|readFile\(|createReadStream|import\.meta\.(url|dirname|filename)/.test(readFileSync(join(ROOT, p), "utf8")), `${p}: no runtime data-file input`);
  }
  assert.equal(P.checkSourceEntries(SOURCES).ok, true);
  assert.equal(build().ok, true);
  // tamper one byte → digest mismatch
  const t = SOURCES.map((e) => ({ path: e.path, bytes: new Uint8Array(e.bytes) })); t[3].bytes[0] ^= 1;
  assert.equal(build({ sourceEntries: t }).code, "SOURCE_DIGEST_MISMATCH");
  const bad = {
    missing: SOURCES.slice(1), extra: [...SOURCES, { path: "x.js", bytes: enc.encode("x") }], dup: [SOURCES[0], ...SOURCES.slice(0, -1)],
    reordered: [SOURCES[1], SOURCES[0], ...SOURCES.slice(2)], empty: [], renamed: SOURCES.map((e, i) => (i === 2 ? { path: `./${e.path}`, bytes: e.bytes } : e)),
    traversal: SOURCES.map((e, i) => (i === 2 ? { path: `lib/../${e.path}`, bytes: e.bytes } : e)),
    buffer: SOURCES.map((e, i) => (i === 0 ? { path: e.path, bytes: Buffer.from(e.bytes) } : e)), string: SOURCES.map((e, i) => (i === 0 ? { path: e.path, bytes: "x" } : e)),
    zero: SOURCES.map((e, i) => (i === 0 ? { path: e.path, bytes: new Uint8Array(0) } : e)), proxy: new Proxy(SOURCES, {}),
    proxyEntry: SOURCES.map((e, i) => (i === 0 ? new Proxy(e, {}) : e)), extraKey: SOURCES.map((e, i) => (i === 0 ? { ...e, origin: "git" } : e)),
    accessor: SOURCES.map((e, i) => (i === 0 ? Object.defineProperty({ path: e.path }, "bytes", { get() { throw new Error("getter ran"); }, enumerable: true }) : e)),
    oversize: SOURCES.map((e, i) => (i === 0 ? { path: e.path, bytes: new Uint8Array(P.MAX_SOURCE_FILE_BYTES + 1) } : e)),
    shared: SOURCES.map((e, i) => (i === 0 ? { path: e.path, bytes: new Uint8Array(new SharedArrayBuffer(4)) } : e))
  };
  for (const [k, s] of Object.entries(bad)) assert.equal(build({ sourceEntries: s }).code, "SOURCE_INVALID", k);
  // a mismatched declared digest (path list fixed, digest computed) is refused
  const p2 = plan(); p2.baseline.sourceDigest = "0".repeat(64);
  assert.equal(build({ planBytes: bytesOf(p2) }).code, "SOURCE_DIGEST_MISMATCH");
});

test("T3 pure import boundary: the command graph is exactly the reviewed pure set; externals node:crypto / node:util; no side-effect tokens", () => {
  const g = scan(["scripts/e7-connected/run-plan-command.mjs"]);
  assert.deepEqual(g.files, ["lib/checkout/capture-proof.js", "lib/checkout/compensation-proof.js", "lib/checkout/intent-state.js", "lib/checkout/recovery-plan.js",
    "lib/direct-pricing.js", "lib/quote-public.js", "scripts/e7-connected/probe-env-preflight.mjs", "scripts/e7-connected/probe-source-digest.mjs",
    "scripts/e7-connected/run-manifest-v2.mjs", "scripts/e7-connected/run-manifest.mjs", "scripts/e7-connected/run-plan-command.mjs", "scripts/e7-connected/run-plan-v1.mjs"]);
  assert.deepEqual(g.external, ["node:crypto", "node:util"]);
  for (const f of g.files) assert.ok(!/(booking-db|e7-operator|worker|journal|transport|exchange|credential|run-core|hostaway|stripe)/i.test(f), `no executable module: ${f}`);
  const forbidden = /\bprocess\.|\bglobalThis\.(?!fetch\b)|\bfetch\(|setTimeout|setInterval|setImmediate|queueMicrotask|\beval\(|new Function|node:fs|node:net|node:http|node:child_process|node:worker_threads|Date\.now\(|new Date\(\)/;
  for (const f of g.files) { const src = readFileSync(join(ROOT, f), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""); assert.ok(!forbidden.test(src), `side-effect token in ${f}: ${(src.match(forbidden) || [])[0]}`); }
  // the planner imports no constant from a DB / worker / operator module
  const planner = readFileSync(join(ROOT, "scripts/e7-connected/run-plan-v1.mjs"), "utf8");
  assert.ok(!/from\s+"[^"]*(booking-db|worker|test-abort|operator|run-core)[^"]*"/.test(planner));
});

test("T4 copied constants: parity with the origin TEXT and the pinned origin SHA-256", () => {
  for (const [p, h] of Object.entries(P.CONSTANT_ORIGINS)) assert.equal(sha(readFileSync(join(ROOT, p))), h, `${p} origin pin`);
  const ta = readFileSync(join(ROOT, "lib/booking-db/test-abort.js"), "utf8");
  const m1 = ta.match(/^export const TEST_ABORT_LISTINGS = Object\.freeze\(\[Object\.freeze\(\{ listingId: (\d+), currency: "([A-Z]{3})" \}\)\]\);$/m);
  assert.ok(m1, "origin TEST_ABORT_LISTINGS literal found (single entry)");
  assert.deepEqual(clone(P.TEST_ABORT_LISTINGS_COPY), [{ listingId: Number(m1[1]), currency: m1[2] }]);
  const rw = readFileSync(join(ROOT, "lib/booking-db/reservation-worker.js"), "utf8");
  const m2 = rw.match(/^export const PROTECTED_HOSTAWAY_RESERVATION_IDS = Object\.freeze\((\[[^\]]*\])\);$/m);
  assert.ok(m2); assert.deepEqual(clone(P.PROTECTED_RESERVATION_IDS_COPY), JSON.parse(m2[1]));
  assert.ok(Object.isFrozen(P.TEST_ABORT_LISTINGS_COPY) && Object.isFrozen(P.TEST_ABORT_LISTINGS_COPY[0]) && Object.isFrozen(P.PROTECTED_RESERVATION_IDS_COPY));
  // the accepted checkpoint constant is REUSED (pure export), equal to the literal
  assert.deepEqual(V(mut((p) => { p.listing.connection = "airbnb"; p.checkpoints = [...CK.airbnb]; })).ok, true);
});

test("T5 execute / unknown modes refuse FIRST with zero deps access (no descriptor, no getter, no call)", async () => {
  let touched = 0;
  const trap = new Proxy({}, { get() { touched++; }, getOwnPropertyDescriptor() { touched++; }, ownKeys() { touched++; return []; }, has() { touched++; return false; } });
  const mk = (argv) => { const o = { argv }; Object.defineProperty(o, "deps", { get() { touched++; return trap; }, enumerable: true }); return o; };
  const cases = [[["execute"], "EXECUTE_NOT_IMPLEMENTED"], [["execute", "--force"], "EXECUTE_NOT_IMPLEMENTED"], [["inspect", "x"], "USAGE"], [["Inspect"], "USAGE"],
    [["plan"], "USAGE"], [[], "USAGE"], [["inspect", "a", "b", "c", "d"], "USAGE"], [[1], "USAGE"], [[new String("inspect")], "USAGE"], ["inspect", "USAGE"], [null, "USAGE"]];
  for (const [argv, c] of cases) {
    const r = await runPlanCommand(mk(argv));
    assert.equal(r.code, c, JSON.stringify(argv)); assert.equal(r.outcome, c); assert.equal(r.executable, false);
  }
  // deps itself a proxy / functions that count
  let calls = 0; const counting = { envSnapshot: ENV(), planClock: () => { calls++; return NOW; }, readPlanFile: async () => { calls++; }, readSourceFiles: async () => { calls++; } };
  assert.equal((await runPlanCommand({ argv: ["execute"], deps: counting })).code, "EXECUTE_NOT_IMPLEMENTED");
  assert.equal((await runPlanCommand({ argv: ["execute"], deps: trap })).code, "EXECUTE_NOT_IMPLEMENTED");
  // argv accessor / proxy argv / proxy input / holey argv / argv extra prop
  const acc = {}; Object.defineProperty(acc, "argv", { get() { touched++; return ["inspect"]; }, enumerable: true }); acc.deps = trap;
  assert.equal((await runPlanCommand(acc)).code, "USAGE");
  assert.equal((await runPlanCommand({ argv: new Proxy(["inspect"], { get() { touched++; } }), deps: trap })).code, "USAGE");
  assert.equal((await runPlanCommand(new Proxy({ argv: ["inspect"], deps: trap }, { get() { touched++; }, getOwnPropertyDescriptor() { touched++; } }))).code, "USAGE");
  const holey = ["inspect"]; holey.length = 2; assert.equal((await runPlanCommand({ argv: holey, deps: trap })).code, "USAGE");
  const extra = ["inspect"]; extra.flag = 1; assert.equal((await runPlanCommand({ argv: extra, deps: trap })).code, "USAGE");
  assert.equal((await runPlanCommand(undefined)).code, "USAGE");
  assert.equal(touched, 0, "no deps / getter / trap touched"); assert.equal(calls, 0, "no dep called");
});

test("T6 inspect OK: exact package, P PASS, L/G NOT_RUN, executable false, permissions false, independent recompute, deps called once", async () => {
  const seen = { clock: 0, plan: 0, src: 0, srcArg: null };
  const d = deps({ planClock: () => { seen.clock++; return NOW; }, readPlanFile: async () => { seen.plan++; return bytesOf(plan()); },
    readSourceFiles: async (paths) => { seen.src++; seen.srcArg = paths; return SOURCES; } });
  const r = await runPlanCommand({ argv: ["inspect"], deps: d });
  assert.equal(r.outcome, "INSPECT_OK"); assert.equal(r.code, "PLAN_OK");
  assert.deepEqual(Object.keys(r).sort(), ["code", "executable", "outcome", "package", "packageHash", "permissions", "planHash", "schema", "sourceDigest"]);
  assert.equal(r.schema, CLI_RESULT_SCHEMA); assert.equal(r.executable, false);
  assert.deepEqual(seen, { clock: 1, plan: 1, src: 1, srcArg: P.RUN_PLAN_CLOSURE }); assert.ok(Object.isFrozen(seen.srcArg));
  for (const perms of [r.permissions, r.package.permissions]) {
    assert.deepEqual(Object.keys(perms).sort(), ["adopt", "cleanup", "dbRead", "dbWrite", "execute", "providerRead", "providerWrite"]);
    assert.ok(Object.values(perms).every((v) => v === false));
  }
  const pk = r.package;
  assert.deepEqual(Object.keys(pk).sort(), ["binding", "checks", "closure", "envReport", "evaluatedAt", "executable", "nature", "permissions", "plan", "planHash", "schema",
    "sourceDigest", "toolchain"]);
  assert.equal(pk.schema, "e7-run-package-v1"); assert.equal(pk.nature, "SCOPE_BINDING_ONLY"); assert.equal(pk.executable, false); assert.equal(pk.binding, "BOUND");
  assert.equal(pk.evaluatedAt, NOW); assert.deepEqual(clone(pk.toolchain), { nodeVersion: "22.22.0", platform: "linux" }); assert.deepEqual(clone(pk.envReport), { code: "ENV_OK" });
  assert.deepEqual(clone(pk.closure), [...P.RUN_PLAN_CLOSURE]);
  assert.deepEqual(Object.keys(pk.checks.P), [...P.P_CHECKS]); assert.ok(Object.values(pk.checks.P).every((v) => v === "PASS"));
  assert.deepEqual(Object.keys(pk.checks.L), [...P.L_CHECKS]); assert.ok(Object.values(pk.checks.L).every((v) => v === "NOT_RUN"));
  assert.deepEqual(Object.keys(pk.checks.G), [...P.G_CHECKS]); assert.ok(Object.values(pk.checks.G).every((v) => v === "NOT_RUN"));
  assert.ok(P.L_CHECKS.includes("paymentIntentRequiresCaptureAmountCurrencyLivemodeExpiryMargin") && P.L_CHECKS.includes("existingRefLookupEmpty"));
  // independent recompute
  assert.deepEqual(clone(pk.plan), plan());
  assert.equal(r.planHash, sha(Buffer.from(`e7-run-plan-v1\n${canonicalJson(plan())}`))); assert.equal(pk.planHash, r.planHash);
  assert.equal(r.packageHash, sha(Buffer.from(`e7-run-package-v1\n${canonicalJson(clone(pk))}`)));
  assert.equal(r.sourceDigest, SOURCE_DIGEST); assert.equal(pk.sourceDigest, SOURCE_DIGEST);
  const frozenDeep = (v) => v === null || typeof v !== "object" || (Object.isFrozen(v) && Object.values(v).every(frozenDeep));
  assert.ok(frozenDeep(r));
  // every validated scope field is bound by both hashes
  const r2 = build({ planBytes: bytesOf(mut((p) => { p.stayRules.maxNights = 6; })) });
  assert.equal(r2.ok, true); assert.notEqual(r2.planHash, r.planHash); assert.notEqual(r2.packageHash, r.packageHash);
  const r3 = build({ planClock: NOW + 1 }); assert.equal(r3.planHash, r.planHash); assert.notEqual(r3.packageHash, r.packageHash, "evaluatedAt bound");
  // UNBOUND is visible and never executable
  const u = await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => bytesOf(plan(false)) }) });
  assert.equal(u.outcome, "INSPECT_OK"); assert.equal(u.package.binding, "UNBOUND"); assert.equal(u.package.checks.P.binding, "UNBOUND");
  assert.equal(u.executable, false); assert.equal(u.package.executable, false); assert.equal(u.package.plan.binding, null);
});

test("T7 hostile snapshots: getters, proxies, boxed, symbols, depth/size; clock typing; mutation during await is irrelevant", async () => {
  let ran = 0;
  const getterPlan = plan(); Object.defineProperty(getterPlan, "runId", { get() { ran++; return "synthetic-plan-0001"; }, enumerable: true });
  const symPlan = plan(); symPlan[Symbol("x")] = 1;
  const hidden = plan(); Object.defineProperty(hidden, "runId", { value: "synthetic-plan-0001", enumerable: false });
  const boxed = plan(); boxed.runId = new String("synthetic-plan-0001");
  const boxedN = plan(); boxedN.binding.amountMinor = new Number(23000);
  const protoPlan = Object.assign(Object.create({ inherited: 1 }), plan());
  const arrExtra = plan(); arrExtra.allowedOps.extra = "x";
  const holey = plan(); holey.allowedOps.length = 11;
  const long = plan(); long.runId = "a".repeat(2000);
  let deep = 1; for (let i = 0; i < 12; i++) deep = { d: deep }; const deepPlan = plan(); deepPlan.runId = deep;
  for (const [k, p] of Object.entries({ getterPlan, symPlan, hidden, boxed, boxedN, protoPlan, arrExtra, holey, long, deepPlan, proxy: new Proxy(plan(), {}), nul: null, str: "x" }))
    assert.equal(code(p), "PLAN_SHAPE", k);
  assert.equal(ran, 0, "no getter executed");
  assert.equal(code(Object.assign(Object.create(null), plan())), "OK", "null-prototype plain data accepted");
  for (const c of [NaN, 1.5, "1", -1, 0, Infinity, new Number(NOW), 2 ** 53]) assert.equal(code(plan(), c), "CLOCK_INVALID", String(c));
  assert.equal(P.validateRunPlanV1(plan(), { planClock: NOW, extra: 1 }).code, "CLOCK_INVALID");
  // command clock typing
  for (const c of [NaN, 1.5, "1", -1, 0, undefined]) assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps({ planClock: () => c }) })).code, "CLOCK_INVALID");
  assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps({ planClock: () => { throw new Error("boom SECRET"); } }) })).code, "CLOCK_INVALID");
  // malformed deps never executed
  let depGetter = 0;
  const accDeps = deps(); Object.defineProperty(accDeps, "planClock", { get() { depGetter++; return () => NOW; }, enumerable: true });
  for (const dd of [accDeps, new Proxy(deps(), {}), { ...deps(), extra: 1 }, (({ planClock, ...x }) => x)(deps()), deps({ readPlanFile: "f" }),
    deps({ readSourceFiles: new Proxy(async () => SOURCES, {}) }), Object.assign(Object.create({ x: 1 }), deps())])
    assert.equal((await runPlanCommand({ argv: ["inspect"], deps: dd })).code, "DEPS_INVALID");
  assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps(), extra: 1 })).code, "DEPS_INVALID");
  assert.equal(depGetter, 0);
  // env snapshot: hostile / refused
  const envGetter = ENV(); Object.defineProperty(envGetter, "platform", { get() { depGetter++; return "linux"; }, enumerable: true });
  for (const e of [envGetter, new Proxy(ENV(), {}), { ...ENV(), nodeVersion: "20.0.0" }, { ...ENV(), execArgvCount: 1 }, { ...ENV(), present: { ...ENV().present, NODE_OPTIONS: true } }])
    assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps({ envSnapshot: e }) })).code, "ENV_REFUSED");
  assert.equal(depGetter, 0);
  // mutation during the awaits: env object, plan bytes and clock state changed after they were read → package unchanged
  const env = ENV(); const pb = bytesOf(plan()); let clockVal = NOW;
  const r = await runPlanCommand({ argv: ["inspect"], deps: { envSnapshot: env, planClock: () => clockVal, readPlanFile: async () => pb,
    readSourceFiles: async () => { env.nodeVersion = "20.0.0"; env.platform = "win32"; pb.fill(0x20); clockVal = 1; return SOURCES; } } });
  assert.equal(r.outcome, "INSPECT_OK"); assert.equal(r.package.toolchain.nodeVersion, "22.22.0"); assert.equal(r.package.evaluatedAt, NOW);
  assert.equal(r.planHash, build().planHash);
  // source bytes mutated after the command returned do not alter the returned package
  const srcCopy = SOURCES.map((e) => ({ path: e.path, bytes: new Uint8Array(e.bytes) }));
  const r4 = await runPlanCommand({ argv: ["inspect"], deps: deps({ readSourceFiles: async () => srcCopy }) }); srcCopy[0].bytes[0] ^= 1;
  assert.equal(r4.sourceDigest, SOURCE_DIGEST);
  // plan bytes: canonical form only
  const good = `${canonicalJson(plan())}\n`;
  const pbCases = {
    pretty: [enc.encode(`${JSON.stringify(plan(), null, 2)}\n`), "PLAN_NOT_CANONICAL"], noNewline: [enc.encode(canonicalJson(plan())), "PLAN_NOT_CANONICAL"],
    dupKey: [enc.encode(good.replace('{"allowedOps"', '{"version":"e7-run-plan-v1","allowedOps"')), "PLAN_NOT_CANONICAL"],
    bom: [new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(good)]), "PLAN_NOT_JSON"], badUtf8: [new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]), "PLAN_NOT_JSON"],
    notJson: [enc.encode("nope\n"), "PLAN_NOT_JSON"], float: [enc.encode('{"a":1.5}\n'), "PLAN_NOT_CANONICAL"],
    deep: [enc.encode(`${"[".repeat(9)}${"]".repeat(9)}\n`), "PLAN_TOO_DEEP"], tooLarge: [enc.encode(`"${"a".repeat(P.MAX_PLAN_BYTES)}"\n`), "PLAN_TOO_LARGE"],
    unownable: [new Uint8Array(P.PLAN_COPY_MAX + 1), "PLAN_BYTES_INVALID"], buffer: [Buffer.from(good), "PLAN_BYTES_INVALID"], empty: [new Uint8Array(0), "PLAN_BYTES_INVALID"],
    string: [good, "PLAN_BYTES_INVALID"], proxy: [new Proxy(enc.encode(good), {}), "PLAN_BYTES_INVALID"]
  };
  for (const [k, [b, c]] of Object.entries(pbCases)) {
    assert.equal(build({ planBytes: b }).code, c, `builder ${k}`);
    if (!["buffer", "string", "proxy", "unownable", "empty"].includes(k)) assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => b }) })).code, c, `command ${k}`);
    else assert.equal((await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => b }) })).code, "PLAN_BYTES_INVALID", `command ${k}`);
  }
  // a string containing braces does not count toward depth
  assert.equal(parseDepthOk(), true);
});
function parseDepthOk() { const r = P.parsePlanBytes(enc.encode(`${canonicalJson({ s: "[[[[[[[[[[{{{{{{{{{\\\"" })}\n`)); return r.ok === true; }

test("T8 exact schema, allowedOps (exact ordered list, not a subset), checkpoints and phases", () => {
  assert.equal(code(plan()), "OK"); assert.equal(code(plan(false)), "OK");
  assert.deepEqual([...P.ALLOWED_OPS], OPS);
  const cases = {
    PLAN_SHAPE: [(p) => { p.extra = 1; }, (p) => { delete p.runId; }, (p) => { p.environment.extra = 1; }, (p) => { p.environment.stripe.extra = 1; }],
    VERSION_UNSUPPORTED: [(p) => { p.version = "e7-run-plan-v2"; }, (p) => { p.version = "e7-run-manifest-v2"; }],
    KIND_UNSUPPORTED: [(p) => { p.kind = "reservation-capture-v1"; }],
    RUN_ID_INVALID: [(p) => { p.runId = "UPPER-CASE-ID"; }, (p) => { p.runId = "short"; }],
    BASELINE_INVALID: [(p) => { p.baseline.repoCommit = "98009445"; }, (p) => { p.baseline.sourceDigest = "X".repeat(64); }, (p) => { p.baseline.extra = 1; }],
    ALLOWED_OPS_NOT_EXACT: [(p) => { p.allowedOps.pop(); }, (p) => { p.allowedOps.reverse(); }, (p) => { p.allowedOps.push("stripe.paymentIntents.capture"); },
      (p) => { p.allowedOps[9] = p.allowedOps[8]; }, (p) => { p.allowedOps = []; }, (p) => { p.allowedOps = { 0: "x" }; }, (p) => { p.allowedOps = [...p.allowedOps, ...p.allowedOps]; }],
    CHECKPOINTS_NOT_EXACT: [(p) => { p.checkpoints = [...CK.airbnb]; }, (p) => { p.checkpoints.pop(); }, (p) => { p.checkpoints.reverse(); }, (p) => { p.checkpoints.push("CALENDAR_REOPENED"); }],
    PHASES_NOT_EXACT: [(p) => { p.phases.capture = true; }, (p) => { p.phases.recording = true; }, (p) => { p.phases.testAbortAfterReservation = false; }, (p) => { p.phases.extra = false; }],
    BINDING_SHAPE: [(p) => { p.binding.reservationId = "70636076"; }, (p) => { delete p.binding.quote; }, (p) => { p.binding.stay.extra = 1; }, (p) => { p.binding.quote.extra = 1; },
      (p) => { p.binding = {}; }, (p) => { p.binding = []; }]
  };
  for (const [c, fs] of Object.entries(cases)) fs.forEach((f, i) => assert.equal(code(mut(f)), c, `${c}#${i}`));
  assert.equal(code(mut((p) => { p.listing.connection = "airbnb"; })), "CHECKPOINTS_NOT_EXACT");
  assert.equal(code(mut((p) => { p.listing.connection = "airbnb"; p.checkpoints = [...CK.airbnb]; })), "OK");
});

test("T9 numeric / time / date / currency / timezone negatives (future and stale), listing-local lead days", () => {
  const C = (f, bind = true) => code(mut(f, bind));
  // environment / listing
  assert.equal(C((p) => { p.environment.stripe.mode = "live"; }), "STRIPE_NOT_TEST");
  assert.equal(C((p) => { p.environment.stripe.accountId = "acct_"; }), "STRIPE_ACCOUNT_INVALID");
  assert.equal(C((p) => { p.environment.hostaway.accountRef = "bad ref"; }), "HOSTAWAY_LABEL_INVALID");
  for (const f of [(p) => { p.environment.db.instanceEnvironment = "dev"; }, (p) => { p.environment.db.appRole = "postgres"; }, (p) => { p.environment.db.reportRole = "mv_booking_app"; }])
    assert.equal(C(f), "DB_SCOPE_INVALID");
  for (const f of [(p) => { p.listing.id = 0; }, (p) => { p.listing.connection = "vrbo"; }, (p) => { p.listing.refFieldId = 0; }, (p) => { p.listing.timeZone = 7; }])
    assert.equal(C(f), "LISTING_INVALID");
  assert.equal(C((p) => { p.listing.id = 891001; }), "LISTING_NOT_ALLOWED");
  assert.equal(C((p) => { p.listing.currency = "MXN"; }), "LISTING_NOT_ALLOWED");
  for (const tz of ["Mars/Base", "+07:00", "", "a".repeat(80)]) assert.equal(C((p) => { p.listing.timeZone = tz; }), "TIMEZONE_INVALID", tz);
  // non-integer / unsafe numbers never reach a field check: the data snapshot refuses them (plans are integer-only canonical JSON)
  for (const f of [(p) => { p.listing.id = 1.5; }, (p) => { p.deadlines.quoteMaxAgeMinutes = 1.5; }, (p) => { p.stayRules.maxNights = 2.5; },
    (p) => { p.binding.stay.guests = 1.5; }, (p) => { p.binding.amountMinor = 1.5; }, (p) => { p.binding.rateBps = 0.5; }, (p) => { p.binding.amountMinor = 2 ** 53; },
    (p) => { p.binding.rateBps = NaN; }, (p) => { p.binding.amountMinor = Infinity; }])
    assert.equal(C(f), "PLAN_SHAPE");
  // createdAt
  assert.equal(C((p) => { p.createdAt = new Date(NOW + 1).toISOString(); }), "CREATED_AT_FUTURE");
  for (const s of ["2027-02-30T00:00:00.000Z", "2027-02-01T03:00:00Z", "2027-02-01 03:00:00.000Z", "2027-02-01T24:00:00.000Z", 1, null])
    assert.equal(C((p) => { p.createdAt = s; }), "CREATED_AT_INVALID", String(s));
  assert.equal(C((p) => { p.createdAt = at(24 * HOUR + 1); }, false), "PLAN_STALE");
  assert.equal(C((p) => { p.createdAt = at(24 * HOUR); }, false), "OK", "24 h boundary");
  // deadlines (policy caps only) and stay rules: bounded safe positive integers
  for (const f of [(p) => { p.deadlines.quoteMaxAgeMinutes = 0; }, (p) => { p.deadlines.quoteMaxAgeMinutes = 31; },
    (p) => { p.deadlines.quoteMaxAgeMinutes = "30"; }, (p) => { p.deadlines.authorizationMaxAgeHours = 25; }, (p) => { p.deadlines.authorizationMaxAgeHours = 0; },
    (p) => { p.deadlines.authorizationMaxAgeHours = -1; }, (p) => { p.deadlines.extra = 1; }])
    assert.equal(C(f), "DEADLINES_INVALID");
  for (const f of [(p) => { p.stayRules.minLeadDays = 6; }, (p) => { p.stayRules.minLeadDays = 366; }, (p) => { p.stayRules.maxNights = 0; }, (p) => { p.stayRules.maxNights = 8; }])
    assert.equal(C(f), "STAY_RULES_INVALID");
  // binding ids
  for (const f of [(p) => { p.binding.intentId = "00000000-0000-4000-8000-0000000000F1"; }, (p) => { p.binding.intentId = "not-a-uuid"; }, (p) => { p.binding.paymentIntentId = null; },
    (p) => { p.binding.paymentIntentId = "pi_x"; }, (p) => { p.binding.expectedRef = "abc"; }])
    assert.equal(C(f), "BINDING_ID_INVALID");
  // dates
  for (const d of ["2027-02-29", "2027-13-01", "2027-3-10", "2027-03-10T00:00:00Z"]) assert.equal(C((p) => { p.binding.stay.arrival = d; }), "BINDING_DATES_INVALID", d);
  assert.equal(C((p) => { p.binding.stay.departure = "2027-03-10"; }), "BINDING_STAY_REVERSED");
  assert.equal(C((p) => { p.binding.stay.departure = "2027-03-09"; }), "BINDING_STAY_REVERSED");
  assert.equal(C((p) => { p.binding.stay.departure = "2027-03-18"; }), "BINDING_NIGHTS");
  assert.equal(C((p) => { p.binding.stay.departure = "2027-03-17"; }), "OK", "7 nights");
  assert.equal(C((p) => { p.binding.stay.departure = "2027-03-11"; p.stayRules.maxNights = 1; }), "OK");
  // lead days in the LISTING zone: the local date is 2027-01-31 (UTC date would be 2027-02-01)
  assert.equal(C((p) => { p.binding.stay.arrival = "2027-02-07"; p.binding.stay.departure = "2027-02-09"; }), "OK", "7 local days (UTC would give 6)");
  assert.equal(C((p) => { p.binding.stay.arrival = "2027-02-06"; p.binding.stay.departure = "2027-02-08"; }), "BINDING_LEAD_TIME");
  assert.equal(C((p) => { p.listing.timeZone = "Etc/UTC"; p.binding.stay.arrival = "2027-02-07"; p.binding.stay.departure = "2027-02-09"; }), "BINDING_LEAD_TIME", "UTC listing: 6 days");
  assert.equal(C((p) => { p.binding.stay.arrival = "2026-12-01"; p.binding.stay.departure = "2026-12-03"; }), "BINDING_LEAD_TIME", "past stay");
  // numbers
  for (const g of [0, 51, -1, "2"]) assert.equal(C((p) => { p.binding.stay.guests = g; }), "BINDING_GUESTS", String(g));
  assert.equal(C((p) => { p.binding.stay.guests = 50; }), "OK");
  for (const a of [0, -1, 100_000_000, "23000"]) assert.equal(C((p) => { p.binding.amountMinor = a; p.binding.quote.totalMinor = a; }), "BINDING_AMOUNT", String(a));
  for (const r of [-1, 10_001]) assert.equal(C((p) => { p.binding.rateBps = r; }), "BINDING_RATE", String(r));
  assert.equal(C((p) => { p.binding.rateBps = 0; }), "OK"); assert.equal(C((p) => { p.binding.rateBps = 10_000; }), "OK");
  assert.equal(C((p) => { p.binding.quote.totalMinor = 22999; }), "QUOTE_MISMATCH");
  assert.equal(C((p) => { p.binding.quote.totalMinor = 0; }), "QUOTE_MISMATCH");
  assert.equal(C((p) => { p.binding.quote.currency = "MXN"; }), "QUOTE_CURRENCY_MISMATCH");
  assert.equal(C((p) => { p.binding.quote.currency = "usd"; }), "QUOTE_CURRENCY_MISMATCH");
  // timestamps: validity, future, ordering, age caps
  for (const f of [(p) => { p.binding.quote.quotedAt = "2027-02-31T00:00:00.000Z"; }, (p) => { p.binding.authorizedAt = "yesterday"; }, (p) => { p.binding.authorizedAt = NOW; }])
    assert.equal(C(f), "TIMESTAMP_INVALID");
  assert.equal(C((p) => { p.binding.quote.quotedAt = new Date(NOW + 1).toISOString(); }), "TIMESTAMP_FUTURE");
  assert.equal(C((p) => { p.binding.authorizedAt = new Date(NOW + 1).toISOString(); }), "TIMESTAMP_FUTURE");
  assert.equal(C((p) => { p.binding.authorizedAt = at(11 * MIN); }), "TIMESTAMP_ORDER", "authorized before quote");
  assert.equal(C((p) => { p.binding.authorizedAt = at(30 * 1000); }), "TIMESTAMP_ORDER", "authorized after plan creation");
  assert.equal(C((p) => { p.binding.quote.quotedAt = at(30 * MIN + 1); }), "QUOTE_TOO_OLD");
  assert.equal(C((p) => { p.binding.quote.quotedAt = at(30 * MIN); }), "OK", "30 min boundary");
  assert.equal(C((p) => { p.deadlines.quoteMaxAgeMinutes = 5; }), "QUOTE_TOO_OLD");
  // AUTHORIZATION_TOO_OLD is dominated: an over-age authorization is always refused earlier (contract §4.2 note)
  assert.equal(C((p) => { p.binding.authorizedAt = at(25 * HOUR); }), "TIMESTAMP_ORDER");
  assert.equal(C((p) => { p.binding.authorizedAt = at(25 * HOUR); p.binding.quote.quotedAt = at(26 * HOUR); }), "QUOTE_TOO_OLD");
});

test("T10 historical exclusions: mandatory, exact (from the ledger), absence explicit; bindings intersecting them refused; dates/amount are not identity", () => {
  assert.deepEqual(clone(P.HISTORICAL_EXCLUSIONS), LEDGER_EXCLUSIONS);
  const ids = [...LEDGER_EXCLUSIONS.runs.flatMap((r) => [r.intentId, r.paymentIntentId]).filter(Boolean), ...LEDGER_EXCLUSIONS.otherPaymentIntentIds, ...LEDGER_EXCLUSIONS.protectedReservationIds];
  assert.equal(new Set(ids).size, ids.length, "no duplicate / ambiguous historical id");
  assert.ok(LEDGER_EXCLUSIONS.runs.every((r) => r.reservationId === null), "no Hostaway reservation existed for Run1/2/3 (explicit null)");
  const C = (f) => code(mut(f));
  const omit = [(p) => { p.exclusions.runs.shift(); }, (p) => { p.exclusions.runs.reverse(); }, (p) => { p.exclusions.runs.push(clone(p.exclusions.runs[0])); },
    (p) => { p.exclusions.runs[0].paymentIntentId = "pi_3GUESSEDGUESSED00"; }, (p) => { delete p.exclusions.runs[1].reservationId; },
    (p) => { p.exclusions.runs[2].paymentIntentId = null; }, (p) => { p.exclusions.otherPaymentIntentIds = []; }, (p) => { p.exclusions.protectedReservationIds.pop(); },
    (p) => { p.exclusions.protectedReservationIds = p.exclusions.protectedReservationIds.map(Number); }, (p) => { p.exclusions = null; }, (p) => { delete p.exclusions.otherPaymentIntentIds; },
    (p) => { p.exclusions.runs[0].sessionId = "cs_test_unknown"; }, (p) => { p.exclusions.extra = []; }];
  omit.forEach((f, i) => assert.equal(C(f), "EXCLUSIONS_NOT_EXACT", `#${i}`));
  for (const r of LEDGER_EXCLUSIONS.runs) assert.equal(C((p) => { p.binding.intentId = r.intentId; }), "BINDING_EXCLUDED", r.label);
  assert.equal(C((p) => { p.binding.paymentIntentId = "pi_3UYqhH2B9LTneQgw1Q0IoYtz"; }), "BINDING_EXCLUDED", "run3 PI");
  assert.equal(C((p) => { p.binding.paymentIntentId = "pi_3UYUIm2B9LTneQgw0mGFQdwG"; }), "BINDING_EXCLUDED", "path-A PI");
  // Run3-like stay and amount (2027-01-18 → 20, 23000) with FRESH synthetic ids/timestamps is not refused by identity (clock earlier so lead days hold)
  const early = Date.parse("2026-12-01T18:00:00.000Z"); const e = (ms) => new Date(early - ms).toISOString();
  const p3 = mut((p) => { p.createdAt = e(MIN); p.binding.quote.quotedAt = e(10 * MIN); p.binding.authorizedAt = e(5 * MIN);
    p.binding.stay = { arrival: "2027-01-18", departure: "2027-01-20", guests: 2 }; });
  assert.equal(code(p3, early), "OK");
  assert.ok(Object.isFrozen(P.HISTORICAL_EXCLUSIONS.runs[2]));
});

test("T11 v1 / v2 manifest cross-refusal", () => {
  for (const p of [plan(), plan(false)]) { assert.equal(validateRunManifest(p).ok, false); assert.equal(validateRunManifestV2(p).ok, false); }
  const manifestish = { version: "e7-run-manifest-v2", runId: "synthetic-run-v2-0001", intentId: "00000000-0000-4000-8000-0000000000c2", baselineCommit: "0".repeat(40),
    synthetic: true, providerMode: { hostaway: "fake", stripe: "mock" } };
  assert.equal(code(manifestish), "PLAN_SHAPE");
  assert.equal(code({ ...plan(), version: "e7-run-manifest-v2" }), "VERSION_UNSUPPORTED");
  assert.equal(build({ planBytes: bytesOf(manifestish) }).code, "PLAN_SHAPE");
});

test("T12 whitelisted refusal output: fixed keys and codes, no echo of plan, env, source or error text", async () => {
  const MARK = "SECRETMARKER";
  const outs = [
    await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => bytesOf(mut((p) => { p.environment.hostaway.accountRef = `${MARK} x`; })) }) }),
    await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => { throw new Error(MARK); } }) }),
    await runPlanCommand({ argv: ["inspect"], deps: deps({ readSourceFiles: async () => { throw new Error(MARK); } }) }),
    await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: () => { throw new Error(MARK); } }) }),
    await runPlanCommand({ argv: ["inspect"], deps: deps({ envSnapshot: { ...ENV(), platform: MARK } }) }),
    await runPlanCommand({ argv: ["inspect"], deps: deps({ readSourceFiles: async () => SOURCES.map((e, i) => (i ? e : { path: MARK, bytes: e.bytes })) }) }),
    await runPlanCommand({ argv: ["execute", MARK], deps: {} })
  ];
  assert.deepEqual(outs.map((o) => o.code), ["HOSTAWAY_LABEL_INVALID", "PLAN_READ_FAILED", "SOURCE_READ_FAILED", "PLAN_READ_FAILED", "ENV_REFUSED", "SOURCE_INVALID", "EXECUTE_NOT_IMPLEMENTED"]);
  for (const o of outs) {
    assert.deepEqual(Object.keys(o).sort(), ["code", "executable", "outcome", "permissions", "schema"]);
    assert.ok(OUTCOMES.includes(o.outcome) && CODES.includes(o.code)); assert.equal(o.executable, false);
    assert.ok(!JSON.stringify(o).includes(MARK)); assert.ok(Object.isFrozen(o));
  }
  // never rejects, even on an exotic thenable
  const r = await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: () => ({ then() { throw new Error(MARK); } }) }) });
  assert.equal(r.code, "PLAN_READ_FAILED");
  assert.ok(runPlanCommand({ argv: ["inspect"], deps: deps() }) instanceof Promise);
  assert.deepEqual([...P.PLAN_CODES].filter((c, i, a) => a.indexOf(c) !== i), [], "unique codes");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// T13 (root M2-F review of 32e8b04): an OWN enumerable data key "__proto__" must be PRESERVED by the snapshot (never routed through the legacy
// prototype setter) and then REFUSED by exact-key validation; it must never collapse onto the clean plan / package hash.
const PROTO_VALUES = [["null", () => null], ["object", () => ({ x: 1 })]];
const withProto = (o, v) => Object.defineProperty(o, "__proto__", { value: v, enumerable: true, writable: true, configurable: true });
const PROTO_SITES = { top: (p) => p, environment: (p) => p.environment, stripe: (p) => p.environment.stripe, db: (p) => p.environment.db, listing: (p) => p.listing,
  phases: (p) => p.phases, deadlines: (p) => p.deadlines, stayRules: (p) => p.stayRules, baseline: (p) => p.baseline, exclusions: (p) => p.exclusions,
  run: (p) => p.exclusions.runs[0], binding: (p) => p.binding, stay: (p) => p.binding.stay, quote: (p) => p.binding.quote };
/** canonical BYTES with "__proto__" spliced in as a key of the object at `site` (JSON.parse creates an OWN property) */
const protoBytes = (site, json) => {
  // MARK sorts immediately after "__proto__" (no other key starts with "__"), so the splice stays canonical
  const MARK = "__proto__x"; const p = plan(); PROTO_SITES[site](p)[MARK] = 0;
  const text = `${canonicalJson(p)}\n`.replace(`"${MARK}":0`, `"__proto__":${json}`);
  return enc.encode(text);
};

test("T13 own __proto__ keys: preserved by snapshotData, refused by exact-key validation, never hash-collapsed (plan, nested, options, env, bytes, command)", async () => {
  const protoBefore = Reflect.ownKeys(Object.prototype).length; let getters = 0;
  // the snapshot keeps the key as an own data property; the copy's prototype is untouched
  for (const [label, val] of PROTO_VALUES) {
    const s = P.snapshotData(JSON.parse(`{"__proto__":${JSON.stringify(val())},"a":1}`));
    assert.ok(s !== null, label); assert.deepEqual(Object.keys(s).sort(), ["__proto__", "a"], label);
    assert.ok(Object.hasOwn(s, "__proto__"), label); assert.equal(Object.getPrototypeOf(s), Object.prototype, `${label}: copy prototype unchanged`);
    assert.ok(Object.isFrozen(s));
    assert.equal(canonicalJson(s), `{"__proto__":${JSON.stringify(val())},"a":1}`);
  }
  const clean = P.planHashV1(V(plan()).plan);
  // validator: every schema object refuses an own __proto__ (direct object input)
  for (const [site, at_] of Object.entries(PROTO_SITES)) for (const [label, val] of PROTO_VALUES) {
    const p = plan(); withProto(at_(p), val());
    const r = V(p); assert.equal(r.ok, false, `${site}/${label} refused`);
    assert.notEqual(r.code, "PLAN_OK");
  }
  // the four sites root reproduced, with their exact refusal codes
  const expectCode = { top: "PLAN_SHAPE", listing: "LISTING_INVALID", binding: "BINDING_SHAPE", exclusions: "EXCLUSIONS_NOT_EXACT" };
  for (const [site, c] of Object.entries(expectCode)) for (const [, val] of PROTO_VALUES) { const p = plan(); withProto(PROTO_SITES[site](p), val()); assert.equal(code(p), c, site); }
  // options and env snapshot
  for (const [, val] of PROTO_VALUES) {
    assert.equal(P.validateRunPlanV1(plan(), withProto({ planClock: NOW }, val())).code, "CLOCK_INVALID");
    assert.equal(build({ envSnapshot: withProto(ENV(), val()) }).code, "ENV_REFUSED");
    const e = ENV(); withProto(e.present, val()); assert.equal(build({ envSnapshot: e }).code, "ENV_REFUSED");
  }
  // canonical BYTES through the builder and the inspect command: refused, whitelisted, nothing leaked, no hash
  for (const site of Object.keys(PROTO_SITES)) for (const [label, val] of PROTO_VALUES) {
    const b = protoBytes(site, JSON.stringify(val()));
    assert.equal(P.parsePlanBytes(b).ok, true, `${site}/${label}: bytes are canonical (not a parse refusal)`);
    const r = build({ planBytes: b }); assert.equal(r.ok, false, `${site}/${label} builder`); assert.ok(!("planHash" in r) && !("packageHash" in r));
    const o = await runPlanCommand({ argv: ["inspect"], deps: deps({ readPlanFile: async () => b }) });
    assert.equal(o.outcome, "PLAN_REFUSED", `${site}/${label} command`); assert.equal(o.code, r.code);
    assert.deepEqual(Object.keys(o).sort(), ["code", "executable", "outcome", "permissions", "schema"]);
    assert.equal(o.executable, false); assert.ok(Object.values(o.permissions).every((v) => v === false));
    assert.ok(!JSON.stringify(o).includes("__proto__"));
  }
  const envP = withProto(ENV(), null);
  const oe = await runPlanCommand({ argv: ["inspect"], deps: deps({ envSnapshot: envP }) }); assert.equal(oe.code, "ENV_REFUSED");
  // controls: clean plain and null-prototype plans still validate, hash identically and are frozen; no getter ran; Object.prototype unchanged
  const np = Object.assign(Object.create(null), plan()); np.listing = Object.assign(Object.create(null), np.listing);
  const vn = V(np); assert.equal(vn.ok, true); assert.equal(P.planHashV1(vn.plan), clean); assert.ok(Object.isFrozen(vn.plan) && Object.isFrozen(vn.plan.listing));
  const ok = await runPlanCommand({ argv: ["inspect"], deps: deps() }); assert.equal(ok.outcome, "INSPECT_OK"); assert.equal(ok.planHash, clean);
  const g = plan(); Object.defineProperty(g, "__proto__", { get() { getters++; return null; }, enumerable: true, configurable: true }); assert.equal(code(g), "PLAN_SHAPE");
  assert.equal(getters, 0); assert.equal(Reflect.ownKeys(Object.prototype).length, protoBefore); assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
