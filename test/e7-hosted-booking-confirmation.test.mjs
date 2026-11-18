// test/e7-hosted-booking-confirmation.test.mjs — C50: the SHIPPED-CLOSED hosted gn-v2 booking-confirmation runner (scripts/e7-hosted-booking-confirmation.mjs).
// Always-on: the CLOSED proof (zero imports / env value reads / DB / provider), labelled copies, closure, plan binding, hosted gates, and the admission /
// core flow through FAKE clients / fake tooling. OPT-IN (E7_HBC_DB_TESTS=1; PG_BIN; E7_TOOLING_DIR = the pinned 66133a22 checkout with its pinned pg (C116 repin from 46b3eaf8)):
// the execute BODY through the test-local constants / deps seam on DISPOSABLE PostgreSQL at schema 26 with the REAL accepted worker, builder, branded
// executor and SQL 23 receipts — the exchange is ALWAYS FAKE (no network). Lifecycle helpers are generated at runtime from the pinned tooling file
// test/db/e7-gn-v2-resend-integration.test.mjs (sha-checked; verbatim; imports rewritten to the tooling checkout). The hosted preflight child never sets
// E7_HBC_DB_TESTS. Nothing here touches a shared database, a provider or the network.
// C119 S1: the DB tests run at schema 27 = the pinned tooling's 0001..0026 + the MERGED e7-test 0027 bytes, read from E7_SCHEMA27_DIR (a checkout of
// e7-test a314681b; both 0027 files sha-checked below). Detect / detect-flow execute / external-cancellation / catalog-27 cases added (H10–H12, D8–D14).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { https: 0, http: 0, fetch: 0 };
https.request = () => { GUARD.https += 1; throw new Error("network refused"); };
https.get = () => { GUARD.https += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.https += 1; throw new Error("network refused"); } };
http.request = () => { GUARD.http += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => { assert.deepEqual(GUARD, { https: 0, http: 0, fetch: 0 }, "no network primitive was touched"); });

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const R = await import("../scripts/e7-hosted-booking-confirmation.mjs");
const C = R.CONSTANTS; const Q = R.ADMISSION_QUERIES;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const IID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607"; const OID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"; const VER = 9;
const PII = /@|SENTINEL|Synthia|Zanabria|re_[A-Za-z0-9]|Bearer|FAKEPW|maraVilla booking|reservaci|Payment received|Pago recibido|Hello/;
const KEY = "re_SENTINELkey0123456789";
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const OPEN = Object.freeze({ ...C, executeEnabled: true });           // the TEST-LOCAL seam only; the shipped constant stays false
/** the C116 schema-26 identity (literal; the CLOSED main runner's previous pin) and the #189 packet's POST-27 notification catalog (literal) */
const PIN26 = Object.freeze({"catalog":"47b1d904a25cde0f4f9f85b8554b93cd914364d70ef1091cb273ce68043379da","readPath":"31f23b641bb57d5cbdec1aa4896447a574190dd057e4b92e6c5fdf8326220baf","readPathCount":6,"sections":{"con":"550534b1daca47fc1df90a557d5dd28a7f6e1f1df11c581cdbd7a671eb95c188","col":"9d645f671980c7a2e0e679aa07d9a3c30a937e488236f132b589a0a162237fbe","fn":"501f34f7f4db9a5a5fb98c00046013a7904745faea78cd731bbafa23ddf8fb7c","pol":"7c69ad5c06cae91f06e96c8ac9d86d97dbc09e94d95a8afb399b141162ee83ee","rel":"359796c40820562166a4f10dce97ae433fe7ae53c5fd2b3385fc41f179437e89","trg":"13e79df7b90097f365a7f3f15337e58c7b7d5277378608fd482c77e2051982f5"}});
const POST27_CATALOG = "bcc116319adfa7c2e0c2f42d32d48b67fdc53ab35cd4058e777e5de5376c6d16";

// ---------------------------------------------------------------------------------------------------------------------------------
test("H1 SHIPPED CLOSED: executeEnabled false; verify AND execute refuse NBC_EXECUTE_CLOSED before ANY tooling import, env VALUE read (secrets present), DB, spawn or provider — proven with throwing deps and a recording env proxy", async () => {
  assert.equal(C.executeEnabled, false); assert.ok(Object.isFrozen(C) && Object.isFrozen(C.sender) && Object.isFrozen(C.budgets));
  for (const mode of ["verify", "detect", "execute"]) {
    const reads = []; const base = { E7_DEV_BOOKING_DATABASE_URL: "postgresql://x", E7_RESEND_TEST_KEY: KEY, E7_APPROVAL_REF: "label", E7_INTENT_ID: IID, E7_OP_ID: OID,
      E7_EXPECTED_VERSION: "9", E7_LOCALE: "en", E7_TOOLING_DIR: TOOLING, GITHUB_REF: "refs/heads/main" };
    const env = new Proxy(base, { get(t, k) { reads.push(String(k)); return t[k]; } });
    const never = () => { throw new Error("must not be called"); };
    const r = await R.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: { importEnv: never, importTooling: never, runCore: never, spawnChild: never, readPgVersion: never, readCa: never } });
    assert.deepEqual([r.exitCode, r.result.code, r.result.executeEnabled, r.result.core, r.result.closureDigest, r.result.planHash], [1, "NBC_EXECUTE_CLOSED", false, null, null, null], mode);
    assert.deepEqual(reads, [], `${mode}: not one env value was read (key names only)`);
    assert.equal(base.E7_RESEND_TEST_KEY, KEY, "nothing deleted / touched");
  }
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-booking-confirmation.mjs"), "utf8"); const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["node:child_process", "node:crypto", "node:fs", "node:fs/promises", "node:process", "node:url"]);
  assert.deepEqual([...code.matchAll(/u\("([^"]+)"\)/g)].map((m) => m[1]).sort(), ["lib/booking-db/notification-worker.js", "lib/booking-db/pool.js", "lib/notify/resend-notification-executor.js", "scripts/e7-resend/resend-exchange.mjs"]);
  const iClosed = code.indexOf('refuse("NBC_EXECUTE_CLOSED")'); assert.ok(iClosed > 0);
  for (const later of ["importEnv(tooling)", "importTooling(tooling)", "readCa(", "readPgVersion(", "framedDigest(tooling", "env.E7_DEV_BOOKING_DATABASE_URL", "env.E7_RESEND_TEST_KEY", "env[INPUT_ENV",
    "env.E7_INPUT_MODE", "env.E7_EXPECTED_CANDIDATE_FINGERPRINT", "runDetect({"])
    assert.ok(code.indexOf(later) > iClosed, `${later} only after the CLOSED gate`);
  assert.doesNotMatch(code, /claim_guest_notification|complete_guest_notification|latch_guest_notification|recover_expired|release_notification_work|claim_notification_work|guest_notification_snapshot|guest_notification_presend|suppress_guest|purge_guest|stripe|hostaway\.com/i);
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/, "no SQL write keyword anywhere in the runner (the ONLY write path is the accepted worker)");
  assert.match(src, /^if \(import\.meta\.main === true\) \{$/m);
  for (const [k, v] of Object.entries(Q)) {
    if (k === "begin") assert.equal(v, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); else if (k === "rollback") assert.equal(v, "ROLLBACK"); else assert.match(v, /^SELECT /, k);
    for (const fn of v.matchAll(/booking\.([a-z_0-9]+)\s*\(/g)) assert.ok(["list_guest_notifications", "external_cancellation_public"].includes(fn[1]), k);
  }
  assert.equal(Q.cancellation, "SELECT booking.external_cancellation_public($1::uuid) AS x", "C119 S1: ONLY the minimal granted 0027 projection");
  assert.doesNotMatch(code, /externally_cancelled\s*\(|external_cancellations\b|external_refund_attestations\b/, "no ungranted 0027 read path");
  for (const [k, v] of Object.entries(R.DETECT_QUERIES)) { assert.match(v, /^SELECT /, k); assert.deepEqual([...v.matchAll(/booking\.([a-z_0-9]+)\s*\(/g)].map((m) => m[1]), ["list_guest_notifications"], k); }
  assert.match(R.POSTCHECK_QUERY, /^SELECT /); assert.doesNotMatch(R.POSTCHECK_QUERY, /booking\.[a-z_]+\s*\(/);
});

test("H2 labelled copies: hosted-boot helpers == scripts/e7-hosted-reservation.mjs; catalog probe / owner-ACL canonicaliser / read path / schema-23 pin / bounded() == scripts/e7-hosted-notify-inspect.mjs (byte-equal SQL)", async () => {
  const H = await import("../scripts/e7-hosted-reservation.mjs"); const I = await import("../scripts/e7-hosted-notify-inspect.mjs");
  for (const v of [null, 1, "x", [1, { b: 2, a: [3] }], { z: { y: null }, a: 1 }]) assert.equal(R.canonical(v), H.canonical(v));
  assert.equal(await R.framedDigest(ROOT, C.runnerFiles, "p\n"), await H.framedDigest(ROOT, C.runnerFiles, "p\n"));
  assert.deepEqual(R.childEnv({ PATH: "/b", E7_RESEND_TEST_KEY: KEY, TZ: "UTC" }, "/t"), H.childEnv({ PATH: "/b", E7_RESEND_TEST_KEY: KEY, TZ: "UTC" }, "/t"));
  const U = "aws-0-us-east-1.pooler.supabase.com";
  for (const u of [`postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`, `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:5432/postgres`, `postgresql://postgres.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`, "nope"])
    assert.equal(R.dbTargetOk(u), H.dbTargetOk(u));
  assert.equal(R.OFFICIAL_CA_SHA256, H.OFFICIAL_CA_SHA256);
  assert.deepEqual([C.listingId, C.dbEnvironment, C.dbProjectRef, C.nodeVersion, [...C.protectedReservationIds]], [H.CONSTANTS.listingId, H.CONSTANTS.dbEnvironment, H.CONSTANTS.dbProjectRef, H.CONSTANTS.nodeVersion, [...H.CONSTANTS.protectedReservationIds]]);
  assert.equal(R.CATALOG_SQL, I.CATALOG_SQL); assert.equal(R.OWNER_ACL_CANON, I.OWNER_ACL_CANON); assert.deepEqual([...R.INSPECT_READ_PATH_FUNCTIONS], [...I.READ_PATH_FUNCTIONS]);
  assert.deepEqual([...R.READ_PATH_FUNCTIONS], [...I.READ_PATH_FUNCTIONS, "external_cancellation_public"], "C119 S1: the inspector's read path + the ONE granted 0027 projection");
  // C119 S1: the schema-27 pin is DERIVED on disposable PG (D0 reproduces the accepted schema-23 and C116 schema-26 pins with the same query); none of 21 / 22 / 23 / 26
  assert.deepEqual(Object.keys(C.catalogPin27).sort(), Object.keys(I.CONSTANTS.catalogPins["23"]).sort());
  for (const v of ["21", "22", "23"]) assert.notEqual(C.catalogPin27.catalog, I.CONSTANTS.catalogPins[v].catalog, `pin 27 != inspector pin ${v}`);
  assert.notEqual(C.catalogPin27.catalog, PIN26.catalog); assert.equal(C.catalogPin27.catalog, POST27_CATALOG, "== the #189 apply packet's POST-27 notification catalog (independent derivation)");
  assert.equal(C.catalogPin27.readPathCount, 7); assert.equal(R.bounded.toString(), I.bounded.toString());
});

test("H3 independent closure at the pinned MERGED tooling 66133a22 (C116 #180 merge; was 46b3eaf8) (five runtime roots → 9 modules incl. C54 lib/notify/sender-identity.js + package files; bare imports node:* and pg only); digest; pg 8.18.0; the tooling exchange is byte-identical to main's reviewed scripts/e7-resend/resend-exchange.mjs", async () => {
  assert.equal(execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), C.toolingCommit, "E7_TOOLING_DIR must be the pinned 66133a22 checkout");
  const bare = new Set();
  const scan = (rel, seen = new Set()) => {
    if (seen.has(rel)) return seen; seen.add(rel);
    const s = readFileSync(join(TOOLING, rel), "utf8");
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
      const t = m[1] ?? m[2] ?? m[3]; if (t.startsWith(".")) scan(join(dirname(rel), t).replace(/\\/g, "/"), seen); else bare.add(t);
    }
    return seen;
  };
  const files = new Set(["package.json", "package-lock.json"]);
  for (const r0 of ["lib/booking-db/notification-worker.js", "lib/notify/resend-notification-executor.js", "scripts/e7-resend/resend-exchange.mjs", "lib/booking-db/pool.js", "scripts/e7-connected/probe-env-preflight.mjs"]) for (const f of scan(r0)) files.add(f);
  assert.deepEqual([...files].sort(), [...C.closure].sort());
  assert.deepEqual([...bare].sort(), ["node:crypto", "node:https", "node:util", "pg"]);
  assert.equal(await R.framedDigest(TOOLING, C.closure, R.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
  assert.equal(sha(readFileSync(join(TOOLING, "scripts/e7-resend/resend-exchange.mjs"))), sha(readFileSync(join(ROOT, "scripts/e7-resend/resend-exchange.mjs"))));
  assert.equal(sha(readFileSync(join(ROOT, "scripts/e7-resend/resend-exchange.mjs"))), "19dae6de5657e1d06a41a68c76bbb53abff07948a3536f8a80cff4204f9f0e99");
  // C55: the plan's sender IS the pinned tooling's approved identity (taken from / asserted equal to it), and the superseded identity is not
  const SI = await import(pathToFileURL(join(TOOLING, "lib/notify/sender-identity.js")).href);
  assert.deepEqual({ ...C.sender }, { ...SI.APPROVED_REAL_SENDER });
  assert.equal(SI.isApprovedRealSender(C.sender.fromAddress, C.sender.fromName), true);
  assert.equal(SI.isApprovedRealSender("bookings@mail.maravillanayarit.com", "maraVilla"), false);
  assert.equal(sha(readFileSync(join(TOOLING, "lib/notify/sender-identity.js"))), "1430b2a60940aa4f7f82f834a2ac99df82cb607b198aab801dca1f2b5a12008a", "the reviewed #120 sender-identity bytes");
  assert.notEqual(C.closureDigest, "d11f8070cda02bd634156172d956a26fb75adc10379200f0be1229546badab9c", "the d322d219 closure is no longer accepted");
});

test("H3b C55 old-pin / tampered tooling refused at the closure check BEFORE any tooling import: the d322d219 shape (no sender-identity.js) and a sender-identity.js rewritten to the superseded identity", async () => {
  const mkTool = (mut) => { const d = mkdtempSync(join(tmpdir(), "e7-c55-tool-"));
    for (const f of C.closure) { mkdirSync(join(d, dirname(f)), { recursive: true }); writeFileSync(join(d, f), readFileSync(join(TOOLING, f))); }
    mut(d); return d; };
  const never = () => { throw new Error("must not be called"); };
  for (const [kind, mut, codes] of [["d322d219 shape (no sender-identity.js)", (d) => rmSync(join(d, "lib/notify/sender-identity.js")), ["NBC_SOURCE_UNREADABLE"]],
    ["superseded identity", (d) => { const f = join(d, "lib/notify/sender-identity.js"); writeFileSync(f, readFileSync(f, "utf8").replace('fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect"', 'fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla"')); }, ["NBC_CLOSURE_MISMATCH"]]]) {
    const d = mkTool(mut);
    try {
      const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: d, PATH: process.env.PATH }, proc: PROC, wrapperDir: ROOT, deps: { importEnv: never, importTooling: never, spawnChild: never, runCore: never } });
      assert.equal(r.exitCode, 1, kind); assert.ok(codes.includes(r.result.code), `${kind}: ${r.result.code}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

test("H4 plan: deterministic; binds intent / op / version / locale / the fixed approved sender / excluded ids / protected ids / one-send budget / tooling / closure / source / schema-23 pin", () => {
  const base = { approvalRef: "label-c50", intentId: IID, opId: OID, expectedVersion: VER, locale: "en", sourceDigest: "a".repeat(64) };
  const h0 = R.buildPlan(C, base).planHash; assert.equal(R.buildPlan(C, { ...base }).planHash, h0);
  for (const [k, v] of [["approvalRef", "x"], ["intentId", "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f608"], ["opId", "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e"], ["expectedVersion", 10], ["locale", "es"], ["sourceDigest", "b".repeat(64)]])
    assert.notEqual(R.buildPlan(C, { ...base, [k]: v }).planHash, h0, k);
  for (const over of [{ sender: { fromAddress: "other@sender.mv-test.invalid", fromName: "maraVilla Test" } }, { sender: { fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" } },
    { sender: { fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla" } }, { toolingCommit: "d322d2192b377d18b6a9280ae06c17eddfe3e73e" }, { excludedIntentIds: [] }, { protectedReservationIds: [] }, { closureDigest: "c".repeat(64) },
    { catalogPin27: {} }, { budgets: { ...C.budgets, sends: 2 } }, { executeEnabled: true }])
    assert.notEqual(R.buildPlan({ ...C, ...over }, base).planHash, h0, Object.keys(over)[0]);
  assert.deepEqual(C.sender, { fromAddress: "bookings@mail.micasadirect.com", fromName: "MiCasaDirect" }, "C55: the fixed approved sender (sender only; not a domain-verification claim)");
  assert.deepEqual([...C.excludedIntentIds], ["abede8b1-8ef6-44f2-876e-6a02fc056a96", "c83c1842-d342-4e27-9ab7-dc3d50b7a309"]);
  assert.deepEqual([C.budgets.workerInvocations, C.budgets.sends], [1, 1]);
});

const SOURCE = await R.framedDigest(ROOT, C.runnerFiles, R.SOURCE_DIGEST_PREFIX);
const inputs = { E7_APPROVAL_REF: "label-c50", E7_INTENT_ID: IID, E7_OP_ID: OID, E7_EXPECTED_VERSION: String(VER), E7_LOCALE: "es" };
const planOf = (c = C, o = {}) => R.buildPlan(c, { approvalRef: "label-c50", intentId: IID, opId: OID, expectedVersion: VER, locale: "es", sourceDigest: SOURCE, ...o }).planHash;
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 4\n# pass 4\n# fail 0\n# skipped 0\n", truncated: false, spawnFailed: false });
const DBURL = "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:FAKEPW@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const gated = (c, over = {}) => ({ E7_TOOLING_DIR: TOOLING, ...inputs, E7_EXPECTED_PLAN_HASH: planOf(c), E7_EXPECTED_SOURCE_DIGEST: SOURCE, E7_EXPECTED_CLOSURE_DIGEST: c.closureDigest,
  E7_WORKFLOW_SHA: "1".repeat(40), E7_RUN_ID: "123456789-1", GITHUB_REF: "refs/heads/main", PATH: process.env.PATH, ...over });

test("H5 preflight (no environment / secret / DB): spawns ONLY the two focused test files; synthetic or REAL plan; refuses any unexpected E7_* (recipient / sender / subject / body / foreign key), a secret NAME, bad / missing locale, and BOTH historical intents by id", async () => {
  let spawned = null;
  const p = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, PATH: process.env.PATH }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async (a, o) => { spawned = { a, o }; return okChild(); } } });
  assert.deepEqual([p.exitCode, p.result.code, p.result.sourceDigest, p.result.closureDigest], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", SOURCE, C.closureDigest]);
  assert.deepEqual(spawned.a, ["--test", "--test-reporter=tap", "test/e7-hosted-booking-confirmation.test.mjs", "test/e7-hosted-booking-confirmation-workflow.test.mjs"]);
  assert.deepEqual(Object.keys(spawned.o.env).sort(), ["E7_TOOLING_DIR", "PATH"]);
  const real = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, ...inputs }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([real.result.code, real.result.planHash], ["PREFLIGHT_OK_REAL_PLAN", planOf()]);
  for (const k of ["E7_RECIPIENT", "E7_TO", "E7_SENDER", "E7_FROM", "E7_SUBJECT", "E7_TEXT", "E7_BODY", "E7_HOSTAWAY_TOKEN", "E7_STRIPE_TEST_KEY", "E7_EXPECTED_RUNNER_DIGEST"]) {
    const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, [k]: "x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: () => assert.fail("never") } });
    assert.equal(r.result.code, "NBC_INPUT_UNEXPECTED", k);
  }
  for (const k of ["E7_DEV_BOOKING_DATABASE_URL", "E7_RESEND_TEST_KEY"]) {
    const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, [k]: "x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: () => assert.fail("never") } });
    assert.equal(r.result.code, "NBC_SECRET_SCOPE_VIOLATION", k);
  }
  for (const [over, code] of [[{ E7_LOCALE: "" }, "NBC_INPUT_INCOMPLETE"], [{ E7_LOCALE: "fr" }, "NBC_INPUT_INVALID"], [{ E7_LOCALE: "EN" }, "NBC_INPUT_INVALID"], [{ E7_OP_ID: IID }, "NBC_INPUT_INVALID"],
    [{ E7_INTENT_ID: "abede8b1-8ef6-44f2-876e-6a02fc056a96" }, "NBC_INTENT_EXCLUDED"], [{ E7_INTENT_ID: "c83c1842-d342-4e27-9ab7-dc3d50b7a309" }, "NBC_INTENT_EXCLUDED"],
    [{ E7_EXPECTED_VERSION: "0" }, "NBC_INPUT_INVALID"], [{ E7_INTENT_ID: C.synthetic.intentId }, "NBC_INPUT_INVALID"]]) {
    const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, ...inputs, ...over }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.equal(r.result.code, code, JSON.stringify(over));
  }
});

function fakeDeps(over = {}) {
  const st = { pools: 0, ended: 0, cfg: null, coreArgs: null, imports: 0 };
  const deps = { spawnChild: okChild, readPgVersion: async () => "8.18.0", readCa: async () => Buffer.from("FAKE-CA"), caSha256: sha(Buffer.from("FAKE-CA")),
    importTooling: async () => { st.imports += 1; return { createBookingPool: (cfg) => { st.pools += 1; st.cfg = { max: cfg.max, statementTimeoutMs: cfg.statementTimeoutMs, ca: cfg.caPem, url: cfg.connectionString === DBURL };
      return { end: async () => { st.ended += 1; } }; }, createResendExchange: () => ({ ok: true, exchange: async () => assert.fail("fake core never calls it") }), tooling: { fake: true } }; },
    runCore: async (args) => { st.coreArgs = { hasPool: !!args.pool, plan: args.plan, key: args.credential() === KEY, runId: args.runId }; return Object.freeze({ code: "PROVIDER_ACCEPTED", admission: "ADMITTED", sendsAttempted: 1, workerInvocations: 1, statements: 30, providerAccepted: true, providerReplay: false, verifiedCompletion: true, readback: "VERIFIED", workerOutcome: "accepted", workerCode: null }); },
    ...over };
  return { deps, st };
}

test("H6b C116 shipped toolingStatus MERGED (the #180 merge 66133a22); a non-MERGED (DRAFT_HEAD) pin can never verify / execute even with executeEnabled true in the seam: NBC_CLOSURE_MISMATCH before any tooling import / secret / DB / provider", async () => {
  assert.equal(C.toolingStatus, "MERGED");
  for (const mode of ["verify", "execute"]) {
    const c = { ...C, executeEnabled: true, toolingStatus: "DRAFT_HEAD" };
    const { deps, st } = fakeDeps(); const r = await R.runHosted({ mode, env: gated(c, mode === "execute" ? { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY } : {}), proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: c } });
    assert.deepEqual([r.exitCode, r.result.code], [1, "NBC_CLOSURE_MISMATCH"], mode);
    assert.deepEqual([st.imports, st.pools], [0, 0], `${mode}: no tooling import / pool`);
  }
});

test("H6 through the TEST-LOCAL seam (executeEnabled true in constants only): verify / execute gates — main ref, run id, plan / source / closure exact, closure drift before import; execute: both secret NAMES required, pinned pg, DB target, pinned CA, then ONE pool (max 2) + the core; both secrets removed from env; key never in the result; pool end bounded", async () => {
  const v = await R.runHosted({ mode: "verify", env: gated(OPEN), proc: PROC, wrapperDir: ROOT, deps: { ...fakeDeps().deps, constants: OPEN } });
  assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"]);
  for (const [over, code] of [[{ GITHUB_REF: "refs/heads/e7-test" }, "NBC_REF_NOT_MAIN"], [{ E7_RUN_ID: "x" }, "NBC_INPUT_INVALID"], [{ E7_EXPECTED_PLAN_HASH: "f".repeat(64) }, "NBC_PLAN_HASH_MISMATCH"],
    [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, "NBC_SOURCE_MISMATCH"], [{ E7_EXPECTED_CLOSURE_DIGEST: "f".repeat(64) }, "NBC_CLOSURE_MISMATCH"], [{ E7_LOCALE: "en" }, "NBC_PLAN_HASH_MISMATCH"],
    [{ E7_TOOLING_DIR: ROOT }, "NBC_LAYOUT_INVALID"], [{ E7_EXPECTED_PLAN_HASH: "" }, "NBC_INPUT_INCOMPLETE"]]) {
    for (const mode of ["verify", "execute"]) {
      const { deps, st } = fakeDeps(); const r = await R.runHosted({ mode, env: gated(OPEN, { ...(mode === "execute" ? { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY } : {}), ...over }), proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: OPEN } });
      assert.equal(r.result.code, code, `${mode} ${JSON.stringify(over)}`); assert.equal(st.imports, 0, "no tooling import before every gate passed"); assert.doesNotMatch(JSON.stringify(r), PII);
    }
  }
  const drift = mkdtempSync(join(tmpdir(), "e7-c50-drift-")); try {
    for (const f of C.closure) { mkdirSync(join(drift, dirname(f)), { recursive: true }); writeFileSync(join(drift, f), readFileSync(join(TOOLING, f))); }
    writeFileSync(join(drift, "lib/booking-db/notification-worker.js"), readFileSync(join(TOOLING, "lib/booking-db/notification-worker.js"), "utf8") + "\n// drift\n");
    const { deps, st } = fakeDeps(); const r = await R.runHosted({ mode: "execute", env: gated(OPEN, { E7_TOOLING_DIR: drift, E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }), proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: OPEN } });
    assert.deepEqual([r.result.code, st.imports], ["NBC_CLOSURE_MISMATCH", 0], "a drifted worker byte refuses before any import");
  } finally { rmSync(drift, { recursive: true, force: true }); }
  for (const [envOver, depOver, code] of [[{ E7_RESEND_TEST_KEY: undefined }, {}, "NBC_CREDENTIALS_MISSING"], [{ E7_DEV_BOOKING_DATABASE_URL: undefined }, {}, "NBC_CREDENTIALS_MISSING"],
    [{}, { readPgVersion: async () => "8.17.0" }, "NBC_DEPENDENCY_MISMATCH"], [{ E7_DEV_BOOKING_DATABASE_URL: DBURL.replace(":6543", ":5432") }, {}, "NBC_DB_TARGET_INVALID"],
    [{}, { readCa: async () => Buffer.from("OTHER") }, "NBC_CA_INVALID"], [{}, { importTooling: async () => { throw new Error("x"); } }, "NBC_IMPORT_FAILED"]]) {
    const env = gated(OPEN, { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY, ...envOver }); for (const k of Object.keys(envOver)) if (envOver[k] === undefined) delete env[k];
    const { deps, st } = fakeDeps(depOver); const r = await R.runHosted({ mode: "execute", env, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: OPEN } });
    assert.deepEqual([r.result.code, st.pools], [code, 0], code); assert.doesNotMatch(JSON.stringify(r), PII);
  }
  const { deps, st } = fakeDeps(); const env = gated(OPEN, { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY });
  const ok = await R.runHosted({ mode: "execute", env, proc: PROC, wrapperDir: ROOT, deps: { ...deps, constants: OPEN } });
  assert.deepEqual([ok.exitCode, ok.result.code, ok.result.core.code, ok.result.cleanup, ok.result.runId], [0, "EXECUTE_DONE", "PROVIDER_ACCEPTED", "POOL_ENDED", "123456789-1"]);
  assert.deepEqual([st.pools, st.ended, st.cfg.max, st.cfg.statementTimeoutMs, st.cfg.ca, st.cfg.url, st.coreArgs.key, st.coreArgs.hasPool], [1, 1, 2, 5000, "FAKE-CA", true, true, true]);
  assert.equal(st.coreArgs.plan.locale, "es"); assert.equal(st.coreArgs.plan.opId, OID);
  assert.deepEqual([Object.hasOwn(env, "E7_DEV_BOOKING_DATABASE_URL"), Object.hasOwn(env, "E7_RESEND_TEST_KEY")], [false, false], "both secrets removed from the environment");
  assert.doesNotMatch(JSON.stringify(ok) + R.summaryMarkdown(ok.result), PII); assert.match(R.summaryMarkdown(ok.result), / deliveryProven=false/);
  const hang = await R.runHosted({ mode: "execute", env: gated({ ...OPEN, budgets: { ...OPEN.budgets, endMs: 50 } }, { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }), proc: PROC, wrapperDir: ROOT,
    deps: { ...fakeDeps({ importTooling: async () => ({ createBookingPool: () => ({ end: () => new Promise(() => {}) }), createResendExchange: () => ({ ok: true, exchange: async () => {} }), tooling: {} }) }).deps, constants: { ...OPEN, budgets: { ...OPEN.budgets, endMs: 50 } } } });
  assert.equal(hang.result.cleanup, "POOL_END_TIMEOUT");
  // C51: an accepted core result WITHOUT a verified completion is never a hosted success (exit 1), whatever its code says
  for (const core of [{ code: "PROVIDER_ACCEPTED", verifiedCompletion: false }, { code: "PROVIDER_ACCEPTED" }, { code: "ACCEPTED_UNVERIFIED_STOP", verifiedCompletion: false, providerAccepted: true }]) {
    const r = await R.runHosted({ mode: "execute", env: gated(OPEN, { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }), proc: PROC, wrapperDir: ROOT, deps: { ...fakeDeps({ runCore: async () => Object.freeze({ ...core }) }).deps, constants: OPEN } });
    assert.deepEqual([r.exitCode, r.result.code], [1, "EXECUTE_DONE"], JSON.stringify(core));
  }
});

// ---- admission + core through FAKES ------------------------------------------------------------------------------------------------------
const PLAN = R.buildPlan(OPEN, { approvalRef: "l", intentId: IID, opId: OID, expectedVersion: VER, locale: "en", sourceDigest: "a".repeat(64) }).plan;
function world(over = {}) {
  return { role: { ro: "on", iso: "repeatable read", su: false, app: true, adm: false, rep: false, own: false }, catalog: C.catalogPin27, instance: { n: 1, env: "test" },
    intent: [{ id: IID, state: "confirmed", version: VER, listing_id: 606998, currency: "USD", protected_reservation: false, email: "SENTINEL@example.test" }],
    ops: [{ id: OID, state: "pending", attempts: 0, dispatched: false, leased: false, completed: false, has_result: false, template: "booking_confirmed", payload_keys: ["template"], protected_payload: false }],
    pages: [[{ op_id: OID, intent_id: IID, class: "ELIGIBLE" }]], artefacts: { renders: 0, latches: 0, receipts: 0, work_leased: 0 }, throwAt: null, ...over };
}
function fakeClient(w, log) {
  let page = 0;
  return { query: async (t, p) => {
    const k = Object.keys(Q).find((x) => Q[x] === t) ?? (t === R.POSTCHECK_QUERY ? "postcheck" : t === R.DETECT_QUERIES.page ? "dpage" : (t.startsWith("BEGIN") || t === "ROLLBACK") ? "tx" : null);
    log.push(k ?? "UNLISTED"); if (!k) throw new Error("unlisted");
    if (w.throwAt === k) throw new Error("SENTINEL db FAKEPW");
    switch (k) {
      case "role": return { rows: [w.role] };
      case "catalog": return { rows: [{ id: { sections: w.catalog.sections, readPath: w.catalog.readPath, readPathCount: w.catalog.readPathCount } }] };
      case "instance": return { rows: [w.instance] }; case "intent": return { rows: w.intent }; case "ops": return { rows: w.ops };
      case "cancellation": return { rows: w.cancellation ?? [{ x: null }] };
      case "dpage": { log.push(`dpage:${JSON.stringify(p.slice(1))}`); return { rows: (w.dpages ?? [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "ELIGIBLE", in_scope: true }]])[w._dp = (w._dp ?? -1) + 1] ?? [] }; }
      case "page": return { rows: w.pages[page++] ?? [] }; case "artefacts": return { rows: [w.artefacts] };
      case "postcheck": return w.postRows !== undefined ? { rows: w.postRows } : { rows: [w.post ?? POST_OK] };
      default: return { rows: [] };
    } }, release: () => {} };
}
const fakePool = (w, log) => ({ connect: async () => fakeClient(w, log) });
const POST_OK = Object.freeze({ state: "succeeded", attempts: 1, resend_ref: true, error_code: null, receipts: 1, replayed: false, template_version: "gn-v2", locale: "en" });
function fakeTooling(behaviour) {
  const st = { invocations: 0, executors: 0, opts: null };
  const tooling = { NOTIFICATION_V2_OPTION_KEY: "confirmationLocale", NOTIFICATION_PROVIDER_OPTION_KEY: "providerExecutor",
    createResendNotificationExecutor: ({ exchange, credential, sender }) => { st.executors += 1; st.exchange = exchange; st.credential = credential; st.sender = sender; return { ok: true, executor: { fake: true } }; },
    runNotificationStep: async (pool, opts) => { st.invocations += 1; st.opts = opts; return behaviour(opts, st); } };
  return { tooling, st };
}
const core = (w, behaviour, c = OPEN, plan = PLAN) => { const log = []; const t = fakeTooling(behaviour);
  return R.runBookingConfirmationCore({ pool: fakePool(w, log), plan, c, tooling: t.tooling, exchange: async () => ({ status: 200 }), credential: () => KEY, runId: "123456789-1" }).then((res) => ({ res, log, st: t.st })); };

test("H7 admission (fake): every refusal is a code, zero worker invocations, zero executors, ROLLBACK; schema must be EXACTLY 27 (C119 S1; 21 / 23 / 26 / drift refused); the 0027 projection: SQL NULL only = not cancelled, cancelled → EXTERNALLY_CANCELLED, error / any other value → CANCELLATION_UNREADABLE; excluded / protected / version / listing / currency / state / op count / unbound op / non-pristine / payload / template / class / render / latch / receipt / work lease", async () => {
  const i1 = (o) => [{ ...world().intent[0], ...o }]; const o1 = (o) => [{ ...world().ops[0], ...o }];
  const cases = [[{ role: { ...world().role, ro: "off" } }, "NOT_READ_ONLY"], [{ role: { ...world().role, su: true } }, "ROLE_REFUSED"], [{ role: { ...world().role, adm: true } }, "ROLE_REFUSED"],
    [{ role: { ...world().role, own: true } }, "ROLE_REFUSED"], [{ catalog: (await import("../scripts/e7-hosted-notify-inspect.mjs")).CONSTANTS.catalogPins["21"] }, "CATALOG_NOT_27"], [{ catalog: (await import("../scripts/e7-hosted-notify-inspect.mjs")).CONSTANTS.catalogPins["23"] }, "CATALOG_NOT_27"],
    [{ catalog: PIN26 }, "CATALOG_NOT_27"], [{ catalog: { ...C.catalogPin27, readPath: PIN26.readPath, readPathCount: 6 } }, "CATALOG_NOT_27"],
    [{ catalog: { ...C.catalogPin27, sections: { ...C.catalogPin27.sections, rel: "e".repeat(64) } } }, "CATALOG_NOT_27"],
    [{ cancellation: [{ x: { cancelled: true, refundStatus: "pending" } }] }, "EXTERNALLY_CANCELLED"], [{ cancellation: [{ x: { cancelled: true, refundStatus: null } }] }, "EXTERNALLY_CANCELLED"],
    [{ cancellation: [] }, "CANCELLATION_UNREADABLE"], [{ cancellation: [{ x: null }, { x: null }] }, "CANCELLATION_UNREADABLE"], [{ cancellation: [{ y: null }] }, "CANCELLATION_UNREADABLE"],
    [{ cancellation: [{ x: false }] }, "CANCELLATION_UNREADABLE"], [{ cancellation: [{ x: {} }] }, "CANCELLATION_UNREADABLE"], [{ cancellation: [{ x: { cancelled: "true" } }] }, "CANCELLATION_UNREADABLE"],
    [{ cancellation: [{ x: [] }] }, "CANCELLATION_UNREADABLE"], [{ cancellation: [{ x: "null" }] }, "CANCELLATION_UNREADABLE"], [{ throwAt: "cancellation" }, "CANCELLATION_UNREADABLE"], [{ instance: { n: 1, env: "live" } }, "NOT_TEST"],
    [{ intent: [] }, "INTENT_NOT_FOUND"], [{ intent: i1({ protected_reservation: true }) }, "PROTECTED"], [{ intent: i1({ listing_id: 603566 }) }, "LISTING_MISMATCH"],
    [{ intent: i1({ version: VER + 1 }) }, "VERSION_MISMATCH"], [{ intent: i1({ currency: "MXN" }) }, "CURRENCY_NOT_USD"], [{ intent: i1({ state: "payment_captured" }) }, "STATE_NOT_CONFIRMED"],
    [{ ops: [] }, "OP_COUNT"], [{ ops: [...o1({}), { ...o1({})[0], id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e" }] }, "OP_COUNT"], [{ ops: o1({ id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e" }) }, "OP_NOT_BOUND"],
    [{ ops: o1({ attempts: 1 }) }, "OP_NOT_PRISTINE"], [{ ops: o1({ state: "outcome_unknown" }) }, "OP_NOT_PRISTINE"], [{ ops: o1({ leased: true }) }, "OP_NOT_PRISTINE"], [{ ops: o1({ dispatched: true }) }, "OP_NOT_PRISTINE"],
    [{ ops: o1({ payload_keys: ["recipient", "template"] }) }, "OP_PAYLOAD_SHAPE"], [{ ops: o1({ template: "not_completed_not_charged" }) }, "TEMPLATE_NOT_V2"], [{ ops: o1({ protected_payload: true }) }, "PROTECTED"],
    [{ pages: [[{ op_id: OID, intent_id: IID, class: "OUT_OF_V1_SCOPE" }]] }, "CLASS_NOT_ELIGIBLE"], [{ pages: [[]] }, "CLASS_NOT_ELIGIBLE"],
    [{ artefacts: { renders: 1, latches: 0, receipts: 0, work_leased: 0 } }, "RENDER_PRESENT"], [{ artefacts: { renders: 0, latches: 1, receipts: 0, work_leased: 0 } }, "LATCH_PRESENT"],
    [{ artefacts: { renders: 0, latches: 0, receipts: 1, work_leased: 0 } }, "RECEIPT_PRESENT"], [{ artefacts: { renders: 0, latches: 0, receipts: 0, work_leased: 1 } }, "WORK_LEASED"]];
  for (const [over, code] of cases) {
    const { res, log, st } = await core(world(over), () => assert.fail("worker must not run"));
    assert.deepEqual([res.code, res.admission, res.workerInvocations, res.sendsAttempted, st.executors], ["NBC_ADMISSION_REFUSED", code, 0, 0, 0], code);
    assert.equal(log.at(-1), "rollback", "ROLLBACK last"); assert.ok(!log.includes("UNLISTED")); assert.equal(res.postcheck, null);
  }
  const ex = await core(world(), () => assert.fail("never"), OPEN, R.buildPlan(OPEN, { approvalRef: "l", intentId: "abede8b1-8ef6-44f2-876e-6a02fc056a96", opId: OID, expectedVersion: VER, locale: "en", sourceDigest: "a".repeat(64) }).plan);
  assert.deepEqual([ex.res.code, ex.res.admission], ["NBC_ADMISSION_REFUSED", "INTENT_EXCLUDED"]);
  const dbf = await core(world({ throwAt: "intent" }), () => assert.fail("never")); assert.deepEqual([dbf.res.code, dbf.res.workerInvocations], ["NBC_DB_FAILED", 0]); assert.doesNotMatch(JSON.stringify(dbf.res), PII);
});

test("H8 core with FAKE tooling: ONE worker invocation with the bound intent / locale / sender / executor + both bound-op hooks; a foreign op at either hook → NBC_BOUND_OP_MISMATCH with ZERO sends; a foreign returned opId refuses; the fence refuses a second exchange call; accepted / replay / unknown / not-sent / worker-refused / post-send throw mapped honestly; provider acceptance is never delivery", async () => {
  const accepted = async (opts, st) => { await opts.hooks.afterInitialObservation(OID); await opts.hooks.afterClaim(OID); await st.exchange({}); return { ok: true, outcome: "accepted", sends: 1, opId: OID, providerReplay: false }; };
  const a = await core(world(), accepted);
  assert.deepEqual([a.res.code, a.res.admission, a.res.workerInvocations, a.res.sendsAttempted, a.res.providerAccepted, a.res.deliveryProven, a.st.invocations], ["PROVIDER_ACCEPTED", "ADMITTED", 1, 1, true, false, 1]);
  const o = a.st.opts;
  assert.deepEqual([o.intentId, o.confirmationLocale, o.listingIds, o.sender, o.env, o.workerId, o.providerExecutor], [IID, "en", [606998], { ...C.sender }, { ...C.workerEnv }, "hbc-123456789-1", { fake: true }]);
  assert.deepEqual(Object.keys(o.hooks).sort(), ["afterClaim", "afterInitialObservation"]); assert.equal(a.st.credential(), KEY); assert.deepEqual(a.st.sender, { ...C.sender });
  assert.deepEqual(a.res.postcheck, { state: "succeeded", attempts: 1, resendRef: true, errorCode: null, receipts: 1, replayed: false, templateVersion: "gn-v2", locale: "en" });
  assert.deepEqual([a.res.verifiedCompletion, a.res.readback], [true, "VERIFIED"]);
  assert.doesNotMatch(JSON.stringify(a.res) + JSON.stringify(a.log), PII);
  const FOREIGN = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e";
  for (const hook of ["afterInitialObservation", "afterClaim"]) {
    const r = await core(world(), async (opts, st) => { if (hook === "afterClaim") await opts.hooks.afterInitialObservation(OID); await opts.hooks[hook](FOREIGN); await st.exchange({}); return { ok: true, outcome: "accepted", opId: FOREIGN }; });
    assert.deepEqual([r.res.code, r.res.sendsAttempted], ["NBC_BOUND_OP_MISMATCH", 0], hook);
  }
  const ret = await core(world(), async (opts, st) => { await st.exchange({}); return { ok: true, outcome: "accepted", opId: FOREIGN }; }); assert.equal(ret.res.code, "NBC_BOUND_OP_MISMATCH");
  const twice = await core(world(), async (opts, st) => { await st.exchange({}); let second = null; try { await st.exchange({}); } catch (e) { second = e.code; } assert.equal(second, "EXCHANGE_SPENT"); return { ok: true, outcome: "unknown", opId: OID, code: "EXCHANGE_SPENT" }; });
  assert.deepEqual([twice.res.code, twice.res.sendsAttempted], ["UNKNOWN_STOP", 2], "the second call is counted and refused by the fence (never reaches the exchange)");
  const replay = await core(world({ post: { ...POST_OK, replayed: true } }), async (opts, st) => { await st.exchange({}); return { ok: true, outcome: "accepted", opId: OID, providerReplay: true }; });
  assert.deepEqual([replay.res.code, replay.res.providerReplay, replay.res.verifiedCompletion], ["PROVIDER_ACCEPTED_REPLAY", true, true]);
  const unk = await core(world(), async (opts, st) => { await st.exchange({}); return { ok: true, outcome: "unknown", opId: OID, code: "HTTP_STATUS" }; }); assert.deepEqual([unk.res.code, unk.res.workerCode, unk.res.providerAccepted], ["UNKNOWN_STOP", "HTTP_STATUS", false]);
  const idle = await core(world(), async () => ({ ok: true, outcome: "not_claimable", opId: OID, code: "PROVIDER_PREPARE_REFUSED", sends: 0 })); assert.deepEqual([idle.res.code, idle.res.sendsAttempted], ["NOT_SENT", 0]);
  const refused = await core(world(), async () => ({ ok: false, code: "OPTIONS_INVALID" })); assert.deepEqual([refused.res.code, refused.res.workerCode], ["NBC_WORKER_REFUSED", "OPTIONS_INVALID"]);
  const thrownAfter = await core(world(), async (opts, st) => { await st.exchange({}); throw new Error("SENTINEL db lost after send FAKEPW"); }); assert.deepEqual([thrownAfter.res.code, thrownAfter.res.sendsAttempted], ["UNKNOWN_STOP", 1]);
  const thrownBefore = await core(world(), async () => { throw new Error("SENTINEL"); }); assert.deepEqual([thrownBefore.res.code, thrownBefore.res.sendsAttempted], ["NBC_WORKER_ERROR", 0]);
  for (const r of [twice, replay, unk, idle, refused, thrownAfter, thrownBefore]) { assert.equal(r.st.invocations <= 1, true); assert.equal(r.res.deliveryProven, false); assert.doesNotMatch(JSON.stringify(r.res), PII); }
  const badEx = await R.runBookingConfirmationCore({ pool: fakePool(world(), []), plan: PLAN, c: OPEN, tooling: { ...fakeTooling(() => assert.fail("never")).tooling, createResendNotificationExecutor: () => ({ ok: false, code: "EXECUTOR_SENDER_INVALID" }) },
    exchange: async () => {}, credential: () => KEY, runId: "123456789-1" });
  assert.deepEqual([badEx.code, badEx.workerInvocations], ["NBC_EXECUTOR_INVALID", 0]);
});

test("H9 C51 verified completion (fake): an accepted worker outcome with the readback unavailable / missing / malformed (strict raw types) / contradicting the durable accepted shape → ACCEPTED_UNVERIFIED_STOP with providerAccepted / replay RETAINED, ONE send, ONE invocation; matching EN / ES / replay readbacks verify; non-accepted outcomes are never upgraded", async () => {
  const accepted = (replay = false) => async (opts, st) => { await opts.hooks.afterInitialObservation(OID); await st.exchange({}); return { ok: true, outcome: "accepted", opId: OID, providerReplay: replay }; };
  const PES = R.buildPlan(OPEN, { approvalRef: "l", intentId: IID, opId: OID, expectedVersion: VER, locale: "es", sourceDigest: "a".repeat(64) }).plan;
  for (const [w, plan, replay, code] of [[world(), PLAN, false, "PROVIDER_ACCEPTED"], [world({ post: { ...POST_OK, locale: "es" } }), PES, false, "PROVIDER_ACCEPTED"],
    [world({ post: { ...POST_OK, replayed: true } }), PLAN, true, "PROVIDER_ACCEPTED_REPLAY"]]) {
    const r = await core(w, accepted(replay), OPEN, plan);
    assert.deepEqual([r.res.code, r.res.verifiedCompletion, r.res.readback, r.res.providerAccepted, r.res.sendsAttempted], [code, true, "VERIFIED", true, 1], plan.locale);
  }
  const bad = [
    [{ throwAt: "postcheck" }, "UNAVAILABLE"], [{ postRows: [] }, "MISSING"], [{ postRows: [POST_OK, POST_OK] }, "MALFORMED"],
    [{ post: { ...POST_OK, attempts: "1" } }, "MALFORMED"], [{ post: { ...POST_OK, attempts: 1.5 } }, "MALFORMED"], [{ post: { ...POST_OK, resend_ref: null } }, "MALFORMED"],
    [{ post: { ...POST_OK, replayed: null } }, "MALFORMED"], [{ post: { ...POST_OK, error_code: "lower case" } }, "MALFORMED"], [{ post: { ...POST_OK, locale: "fr" } }, "MALFORMED"],
    [{ post: { ...POST_OK, template_version: "gn-v3" } }, "MALFORMED"], [{ post: { ...POST_OK, receipts: -1 } }, "MALFORMED"], [{ post: { ...POST_OK, state: "SUCCEEDED" } }, "MALFORMED"],
    [{ post: { ...POST_OK, extra: 1 } }, "MALFORMED"], [{ post: (({ locale, ...x }) => x)(POST_OK) }, "MALFORMED"],
    [{ post: { ...POST_OK, state: "outcome_unknown" } }, "CONTRADICTS"], [{ post: { ...POST_OK, state: "in_flight" } }, "CONTRADICTS"], [{ post: { ...POST_OK, attempts: 2 } }, "CONTRADICTS"],
    [{ post: { ...POST_OK, attempts: 0 } }, "CONTRADICTS"], [{ post: { ...POST_OK, resend_ref: false } }, "CONTRADICTS"], [{ post: { ...POST_OK, error_code: "HTTP_STATUS" } }, "CONTRADICTS"],
    [{ post: { ...POST_OK, receipts: 0 } }, "CONTRADICTS"], [{ post: { ...POST_OK, receipts: 2 } }, "CONTRADICTS"], [{ post: { ...POST_OK, template_version: "gn-v1" } }, "CONTRADICTS"],
    [{ post: { ...POST_OK, template_version: null } }, "CONTRADICTS"], [{ post: { ...POST_OK, locale: "es" } }, "CONTRADICTS"], [{ post: { ...POST_OK, locale: null } }, "CONTRADICTS"],
    [{ post: { ...POST_OK, replayed: true } }, "CONTRADICTS"]];
  for (const [over, rb] of bad) {
    const r = await core(world(over), accepted(false));
    assert.deepEqual([r.res.code, r.res.readback, r.res.verifiedCompletion, r.res.providerAccepted, r.res.providerReplay, r.res.sendsAttempted, r.res.workerInvocations, r.res.deliveryProven],
      ["ACCEPTED_UNVERIFIED_STOP", rb, false, true, false, 1, 1, false], JSON.stringify(over));
    assert.equal(r.res.postcheck === null, rb !== "CONTRADICTS", "a malformed / missing / unavailable readback is never mapped into a plausible value");
    assert.doesNotMatch(JSON.stringify(r.res), PII);
  }
  const replayButFresh = await core(world(), accepted(true));
  assert.deepEqual([replayButFresh.res.code, replayButFresh.res.readback, replayButFresh.res.providerReplay], ["ACCEPTED_UNVERIFIED_STOP", "CONTRADICTS", true], "replay consistency both ways");
  const unk = await core(world({ post: { ...POST_OK, state: "outcome_unknown", resend_ref: false, receipts: 0, error_code: "HTTP_STATUS" } }), async (opts, st) => { await st.exchange({}); return { ok: true, outcome: "unknown", opId: OID, code: "HTTP_STATUS" }; });
  assert.deepEqual([unk.res.code, unk.res.readback, unk.res.verifiedCompletion], ["UNKNOWN_STOP", "NOT_REQUIRED", false]);
  const unkDown = await core(world({ throwAt: "postcheck" }), async (opts, st) => { await st.exchange({}); return { ok: true, outcome: "unknown", opId: OID, code: "HTTP_STATUS" }; });
  assert.deepEqual([unkDown.res.code, unkDown.res.readback], ["UNKNOWN_STOP", "UNAVAILABLE"], "a non-accepted outcome keeps its honest classification");
  assert.deepEqual(R.parseReadback({ rows: [{ ...POST_OK }] }), { kind: "OK", value: { state: "succeeded", attempts: 1, resendRef: true, errorCode: null, receipts: 1, replayed: false, templateVersion: "gn-v2", locale: "en" } });
  assert.match(R.POSTCHECK_QUERY, /coalesce\(o\.result_ref LIKE 'resend:%', false\) AS resend_ref/, "the SQL itself yields a strict boolean (no NULL coerced in JS)");
});

// ---- C119 S1: DETECT + detect-flow execute through FAKES ---------------------------------------------------------------------------------
const OID2 = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e"; const IID2 = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f608";
const row = (o = {}) => ({ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "ELIGIBLE", in_scope: true, ...o });
const detectWith = (over, c = OPEN) => { const log = []; return R.runDetectCore({ pool: fakePool(world(over), log), c, sourceDigest: "a".repeat(64) }).then((res) => ({ res, log })); };
const FP = R.detectPlan(OPEN, { intentId: IID, opId: OID, version: VER }, "a".repeat(64)).planHash;

test("H10 C119 detect (fake): NONE / ONE / conservative STOP; the fingerprint is the planHash of the server-derived plan; every in-scope unknown / in-flight / other / waiting / out-of-scope / unrecognised class STOPs (never skipped); >1 eligible → STOP DETECT_MORE_THAN_ONE (capacity limitation); bounded pages; historic / excluded / other-template rows never selected; the candidate must pass the UNCHANGED admission (incl. the 0027 projection); outputs carry no identifier", async () => {
  const one = await detectWith({});
  assert.deepEqual([one.res.outcome, one.res.code, one.res.admission, one.res.fingerprint], ["ONE", "DETECT_ONE", "ADMITTED", FP]);
  assert.equal(FP, R.buildPlan(OPEN, { approvalRef: "E7-HBC-DETECT-v1", intentId: IID, opId: OID, expectedVersion: VER, locale: "en", sourceDigest: "a".repeat(64) }).planHash);
  assert.notEqual(FP, R.detectPlan(OPEN, { intentId: IID, opId: OID, version: VER + 1 }, "a".repeat(64)).planHash, "the version is bound");
  assert.notEqual(FP, R.detectPlan(OPEN, { intentId: IID, opId: OID, version: VER }, "b".repeat(64)).planHash, "the source is bound");
  assert.ok(one.log.includes("dpage:[null,100,\"2026-11-15T22:58:01.000Z\"]"), "listing page, no cursor, the reviewed page limit + cutoff");
  assert.deepEqual([one.log.filter((k) => k === "begin").length, one.log.filter((k) => k === "rollback").length], [2, 2], "two read-only snapshots (selection + admission), each BEGIN … ROLLBACK");
  assert.ok(!one.log.includes("UNLISTED"));
  for (const r of [one]) { const t = JSON.stringify(r.res); assert.ok(!t.includes(IID) && !t.includes(OID), "no intent / op id in the detect result"); assert.doesNotMatch(t, PII); }
  const none = [[[]], [[row({ class: "SUCCEEDED" }), row({ op_id: OID2, intent_id: IID2, class: "LATCHED" })]], [[row({ in_scope: false })]], [[row({ in_scope: false, class: "UNKNOWN" })]],
    [[row({ intent_id: "1d6e770f-ba3d-40f7-92c1-ee01be7da532" })]], [[row({ intent_id: "abede8b1-8ef6-44f2-876e-6a02fc056a96" })]], [[row({ template: "not_completed_not_charged" })]],
    [[row({ template: "not_charged_authorization_may_show", class: "OTHER" })]]];
  for (const dpages of none) { const r = await detectWith({ dpages }); assert.deepEqual([r.res.outcome, r.res.code, r.res.fingerprint, r.res.admission], ["NONE", "DETECT_NONE", null, null], JSON.stringify(dpages)); }
  const h = await detectWith({ dpages: [[row({ in_scope: false, class: "UNKNOWN" }), row({ class: "SUCCEEDED", op_id: OID2 })]] });
  assert.deepEqual([h.res.counts.historic, h.res.counts.historicUnresolved, h.res.counts.terminal], [1, 1, 1], "historic unresolved rows are COUNTED (visible), never selected");
  for (const cls of ["IN_FLIGHT", "UNKNOWN", "OTHER", "WAITING", "OUT_OF_V1_SCOPE", "PROTECTED", "NOT_NOTIFY", "eligible", "SOMETHING_NEW"]) {
    const r = await detectWith({ dpages: [[row(), row({ op_id: OID2, intent_id: IID2, class: cls })]] });
    assert.deepEqual([r.res.outcome, r.res.code, r.res.fingerprint], ["STOP", "DETECT_ATTENTION", null], cls);
  }
  for (const cls of ["IN_FLIGHT", "UNKNOWN"]) { const r = await detectWith({ dpages: [[row({ template: "not_completed_not_charged", class: cls })]] }); assert.deepEqual([r.res.outcome, r.res.code], ["STOP", "DETECT_ATTENTION"], `other template ${cls}`); }
  const two = await detectWith({ dpages: [[row(), row({ op_id: OID2, intent_id: IID2 })]] });
  assert.deepEqual([two.res.outcome, two.res.code, two.res.fingerprint, two.res.admission], ["STOP", "DETECT_MORE_THAN_ONE", null, null], "CAPACITY LIMITATION: never picks one of several");
  const full = Array.from({ length: 100 }, (_, n) => row({ op_id: `7a8b9c0d-1e2f-4a3b-8c4d-${String(n).padStart(12, "0")}`, class: "SUCCEEDED" }));
  const paged = await detectWith({ dpages: [full, [row()]] });
  assert.deepEqual([paged.res.outcome, paged.res.counts.pages], ["ONE", 2]); assert.ok(paged.log.includes(`dpage:["${full[99].op_id}",100,"2026-11-15T22:58:01.000Z"]`), "cursor = the last op id of the previous page");
  const budget = await detectWith({ dpages: Array.from({ length: 21 }, () => full) });
  assert.deepEqual([budget.res.outcome, budget.res.code, budget.res.counts.pages], ["STOP", "DETECT_BUDGET", 20], "bounded: never an unbounded scan, never a partial NONE");
  for (const bad of [[[{ ...row(), op_id: "x" }]], [[{ ...row(), in_scope: "t" }]], [[{ ...row(), class: null }]], [[{ ...row(), template: 3 }]], [[{ ...row(), intent_id: null }]], [Array.from({ length: 101 }, () => row())]]) {
    const r = await detectWith({ dpages: bad }); assert.deepEqual([r.res.outcome, r.res.code], ["STOP", "DETECT_REPLY_SHAPE"], JSON.stringify(bad).slice(0, 60));
  }
  for (const [over, code] of [[{ role: { ...world().role, ro: "off" } }, "DETECT_SESSION_REFUSED"], [{ role: { ...world().role, own: true } }, "DETECT_SESSION_REFUSED"], [{ catalog: PIN26 }, "DETECT_SESSION_REFUSED"],
    [{ instance: { n: 1, env: "live" } }, "DETECT_SESSION_REFUSED"], [{ throwAt: "dpage" }, "DETECT_DB_FAILED"], [{ throwAt: "role" }, "DETECT_DB_FAILED"], [{ intent: [] }, "DETECT_REPLY_SHAPE"]]) {
    const r = await detectWith(over); assert.deepEqual([r.res.outcome, r.res.code, r.res.fingerprint], ["STOP", code, null], code);
  }
  // the ONE candidate must pass the UNCHANGED admission: cancellation / unreadable projection / version / state / pristine / artefacts / lease
  for (const [over, adm] of [[{ cancellation: [{ x: { cancelled: true, refundStatus: "pending" } }] }, "EXTERNALLY_CANCELLED"], [{ throwAt: "cancellation" }, "CANCELLATION_UNREADABLE"],
    [{ cancellation: [{ x: 1 }] }, "CANCELLATION_UNREADABLE"], [{ intent: [{ ...world().intent[0], state: "payment_captured" }] }, "STATE_NOT_CONFIRMED"],
    [{ ops: [{ ...world().ops[0], attempts: 1 }] }, "OP_NOT_PRISTINE"], [{ pages: [[{ op_id: OID, intent_id: IID, class: "WAITING" }]] }, "CLASS_NOT_ELIGIBLE"],
    [{ artefacts: { renders: 0, latches: 0, receipts: 0, work_leased: 1 } }, "WORK_LEASED"], [{ intent: [{ ...world().intent[0], listing_id: 603566 }] }, "LISTING_MISMATCH"]]) {
    const r = await detectWith(over); assert.deepEqual([r.res.outcome, r.res.code, r.res.admission, r.res.fingerprint], ["STOP", "DETECT_NOT_ADMISSIBLE", adm, null], adm);
  }
  const conn = await R.runDetectCore({ pool: { connect: async () => { throw new Error("SENTINEL FAKEPW"); } }, c: OPEN, sourceDigest: "a".repeat(64) });
  assert.deepEqual([conn.outcome, conn.code], ["STOP", "DETECT_DB_FAILED"]); assert.doesNotMatch(JSON.stringify(conn), PII);
});

test("H11 C119 detect-flow core (fake): re-selects server-side and requires the SAME fingerprint before admission; a changed / vanished / multiplied candidate or a different version / source → NBC_CANDIDATE_CHANGED with ZERO worker invocations and ZERO sends; a match runs the unchanged admission + ONE worker invocation bound to the server-derived op", async () => {
  const accepted = async (opts, st) => { await opts.hooks.afterInitialObservation(OID); await opts.hooks.afterClaim(OID); await st.exchange({}); return { ok: true, outcome: "accepted", opId: OID, providerReplay: false }; };
  const dcore = (w, fp, behaviour = accepted, src = "a".repeat(64)) => { const log = []; const t = fakeTooling(behaviour);
    return R.runBookingConfirmationCore({ pool: fakePool(w, log), plan: null, c: OPEN, tooling: t.tooling, exchange: async () => ({ status: 200 }), credential: () => KEY, runId: "123456789-1",
      detected: { expectedFingerprint: fp, sourceDigest: src } }).then((res) => ({ res, log, st: t.st })); };
  const ok = await dcore(world(), FP);
  assert.deepEqual([ok.res.flow, ok.res.detectCode, ok.res.code, ok.res.admission, ok.res.workerInvocations, ok.res.sendsAttempted, ok.res.verifiedCompletion], ["detect", "DETECT_ONE", "PROVIDER_ACCEPTED", "ADMITTED", 1, 1, true]);
  assert.deepEqual([ok.st.opts.intentId, ok.st.opts.confirmationLocale], [IID, "en"], "the worker is scoped to the server-derived intent, locale en");
  assert.doesNotMatch(JSON.stringify(ok.res), PII);
  for (const [w, fp, src, why] of [[world(), "f".repeat(64), undefined, "other fingerprint"], [world({ intent: [{ ...world().intent[0], version: VER + 1 }] }), FP, undefined, "same op, version moved"],
    [world({ dpages: [[]] }), FP, undefined, "candidate vanished (sent / latched / cancelled)"], [world({ dpages: [[row(), row({ op_id: OID2, intent_id: IID2 })]] }), FP, undefined, "a second candidate appeared"],
    [world({ dpages: [[row({ class: "IN_FLIGHT" })]] }), FP, undefined, "another runner claimed it"], [world(), FP, "b".repeat(64), "a different source"], [world(), "", undefined, "no fingerprint"],
    [world({ throwAt: "dpage" }), FP, undefined, "selection unreadable"]]) {
    const r = await dcore(w, fp, () => assert.fail("worker must not run"), src);
    assert.deepEqual([r.res.workerInvocations, r.res.sendsAttempted, r.st.executors], [0, 0, 0], why);
    assert.ok(["NBC_CANDIDATE_CHANGED", "NBC_DB_FAILED"].includes(r.res.code), `${why}: ${r.res.code}`);
  }
  const plus = await R.runBookingConfirmationCore({ pool: fakePool(world(), []), plan: PLAN, c: OPEN, tooling: fakeTooling(() => assert.fail("never")).tooling, exchange: async () => {}, credential: () => KEY, runId: "123456789-1",
    detected: { expectedFingerprint: FP, sourceDigest: "a".repeat(64) } });
  assert.deepEqual([plus.code, plus.workerInvocations], ["NBC_CANDIDATE_CHANGED", 0], "a hand-bound plan is never mixed into a detect flow");
  // detect passes but admission (same snapshot facts) fails → the unchanged admission refusal, zero sends
  const canc = await dcore(world({ cancellation: [{ x: { cancelled: true, refundStatus: "pending" } }] }), FP, () => assert.fail("never"));
  assert.deepEqual([canc.res.code, canc.res.admission, canc.res.workerInvocations], ["NBC_ADMISSION_REFUSED", "EXTERNALLY_CANCELLED", 0]);
});

test("H12 C119 hosted detect / detect-flow gates (seam): detect needs ONLY the DB secret (a Resend key → NBC_SECRET_SCOPE_VIOLATION), no binding input / plan hash / fingerprint, both digests; it never imports an exchange; STOP exits 1; outputs = outcome + fingerprint only; verify / execute of a detect flow refuse bindings, require the fingerprint (execute) and hand the core NO plan; a manual flow refuses a fingerprint", async () => {
  const dg = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: SOURCE, E7_EXPECTED_CLOSURE_DIGEST: OPEN.closureDigest, E7_WORKFLOW_SHA: "1".repeat(40), E7_RUN_ID: "123456789-1",
    GITHUB_REF: "refs/heads/main", PATH: process.env.PATH, ...over });
  const mk = (detectRes) => { const st = { detect: null, exchanges: 0, pools: 0, maxes: [] }; const deps = { ...fakeDeps().deps, constants: OPEN,
    importTooling: async () => ({ createBookingPool: (cfg) => { st.pools += 1; st.maxes.push(cfg.max); return { end: async () => {} }; }, createResendExchange: () => { st.exchanges += 1; return { ok: true, exchange: async () => {} }; }, tooling: {} }),
    runDetect: async (a) => { st.detect = { sourceDigest: a.sourceDigest, hasPool: !!a.pool }; return Object.freeze(detectRes); }, runCore: async (a) => { st.core = { plan: a.plan, detected: a.detected }; return Object.freeze({ code: "PROVIDER_ACCEPTED", verifiedCompletion: true }); } };
    return { st, deps }; };
  const ONE = { outcome: "ONE", code: "DETECT_ONE", fingerprint: FP, admission: "ADMITTED", counts: { pages: 1 }, statements: 9 };
  let m = mk(ONE); let r = await R.runHosted({ mode: "detect", env: dg({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: m.deps });
  assert.deepEqual([r.exitCode, r.result.code, r.result.planKind, r.result.planHash, r.result.outputs, m.st.detect.sourceDigest, m.st.exchanges, m.st.maxes], [0, "DETECT_DONE", "DETECT", null, { outcome: "ONE", fingerprint: FP }, SOURCE, 0, [1]]);
  assert.doesNotMatch(JSON.stringify(r) + R.summaryMarkdown(r.result), PII); assert.match(R.summaryMarkdown(r.result), / detect=ONE\/DETECT_ONE /);
  for (const res of [{ outcome: "STOP", code: "DETECT_MORE_THAN_ONE", fingerprint: null }, { outcome: "STOP", code: "DETECT_ATTENTION", fingerprint: null }]) {
    m = mk(res); r = await R.runHosted({ mode: "detect", env: dg({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: m.deps });
    assert.deepEqual([r.exitCode, r.result.outputs], [1, { outcome: "STOP", fingerprint: "" }], res.code);
  }
  m = mk({ outcome: "NONE", code: "DETECT_NONE", fingerprint: "f".repeat(64) }); r = await R.runHosted({ mode: "detect", env: dg({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: m.deps });
  assert.deepEqual([r.exitCode, r.result.outputs], [0, { outcome: "NONE", fingerprint: "" }], "a fingerprint is only ever output for ONE");
  for (const [over, code] of [[{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }, "NBC_SECRET_SCOPE_VIOLATION"], [{}, "NBC_CREDENTIALS_MISSING"],
    [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_INTENT_ID: IID }, "NBC_INPUT_INCOMPLETE"], [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, ...inputs }, "NBC_INPUT_UNEXPECTED"],
    [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_PLAN_HASH: "a".repeat(64) }, "NBC_INPUT_UNEXPECTED"], [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_CANDIDATE_FINGERPRINT: FP }, "NBC_INPUT_UNEXPECTED"],
    [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_INPUT_MODE: "manual" }, "NBC_INPUT_INVALID"], [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_SOURCE_DIGEST: "" }, "NBC_INPUT_INCOMPLETE"],
    [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, "NBC_SOURCE_MISMATCH"], [{ E7_DEV_BOOKING_DATABASE_URL: DBURL, GITHUB_REF: "refs/heads/x" }, "NBC_REF_NOT_MAIN"],
    [{ E7_DEV_BOOKING_DATABASE_URL: DBURL.replace(":6543", ":5432") }, "NBC_DB_TARGET_INVALID"]]) {
    m = mk(ONE); r = await R.runHosted({ mode: "detect", env: dg(over), proc: PROC, wrapperDir: ROOT, deps: m.deps });
    assert.deepEqual([r.exitCode, r.result.code, m.st.detect, m.st.pools], [1, code, null, 0], `${code} ${Object.keys(over)}`); assert.doesNotMatch(JSON.stringify(r), PII);
  }
  // verify / execute of a detect flow
  m = mk(ONE); r = await R.runHosted({ mode: "verify", env: dg({ E7_INPUT_MODE: "detect" }), proc: PROC, wrapperDir: ROOT, deps: m.deps });
  assert.deepEqual([r.exitCode, r.result.code, r.result.planKind], [0, "VERIFY_OK", "DETECT"]);
  m = mk(ONE); r = await R.runHosted({ mode: "execute", env: dg({ E7_INPUT_MODE: "detect", E7_EXPECTED_CANDIDATE_FINGERPRINT: FP, E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }), proc: PROC, wrapperDir: ROOT, deps: m.deps });
  assert.deepEqual([r.exitCode, r.result.code, m.st.core.plan, m.st.core.detected], [0, "EXECUTE_DONE", null, { expectedFingerprint: FP, sourceDigest: SOURCE }]);
  for (const [mode, over, code] of [["execute", { E7_INPUT_MODE: "detect", E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }, "NBC_INPUT_INCOMPLETE"],
    ["execute", { E7_INPUT_MODE: "detect", E7_EXPECTED_CANDIDATE_FINGERPRINT: "xyz", E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }, "NBC_INPUT_INCOMPLETE"],
    ["execute", { E7_INPUT_MODE: "detect", E7_EXPECTED_CANDIDATE_FINGERPRINT: FP, ...inputs, E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RESEND_TEST_KEY: KEY }, "NBC_INPUT_UNEXPECTED"],
    ["verify", { E7_INPUT_MODE: "detect", E7_EXPECTED_PLAN_HASH: "a".repeat(64) }, "NBC_INPUT_UNEXPECTED"], ["verify", { E7_INPUT_MODE: "other" }, "NBC_INPUT_INVALID"],
    ["verify", { ...inputs, E7_EXPECTED_PLAN_HASH: planOf(OPEN), E7_INPUT_MODE: "manual", E7_EXPECTED_CANDIDATE_FINGERPRINT: FP }, "NBC_INPUT_UNEXPECTED"],
    ["preflight", { E7_INPUT_MODE: "detect" }, "NBC_INPUT_INVALID"]]) {
    m = mk(ONE); r = await R.runHosted({ mode, env: dg(over), proc: PROC, wrapperDir: ROOT, deps: m.deps });
    assert.deepEqual([r.exitCode, r.result.code, m.st.core ?? null], [1, code, null], `${mode} ${code}`);
  }
  // the manual flow is unchanged (E7_INPUT_MODE manual and an EMPTY fingerprint, as the workflow passes them)
  m = mk(ONE); r = await R.runHosted({ mode: "verify", env: { ...gated(OPEN), E7_INPUT_MODE: "manual", E7_EXPECTED_CANDIDATE_FINGERPRINT: "" }, proc: PROC, wrapperDir: ROOT, deps: m.deps });
  assert.deepEqual([r.exitCode, r.result.code, r.result.planKind], [0, "VERIFY_OK", "REAL"]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN REAL DISPOSABLE POSTGRESQL at schema 26 (C116) with the REAL accepted worker / builder / executor / SQL — FAKE exchange only
if (process.env.E7_HBC_DB_TESTS === "1") {
  const SRC = "test/db/e7-gn-v2-resend-integration.test.mjs"; const SRC_SHA = "1c847a2d6ade0e3aa3f7e8bbdeb7727a4456cb49ad93ecdbe3b9be56ac5d63a0";   // C116: at 66133a22 (authorizedBooking gained the guestEmail option + P10); C55: 22ed2f72… at 46b3eaf8 (was 9533197d… at d322d219; changed ONLY by the reviewed #120 commits 589fd9ae + 75132753: C54 P9 + expectedV2 sender param)
  const text = readFileSync(join(TOOLING, SRC), "utf8"); assert.equal(sha(text), SRC_SHA, "the pinned accepted helper source");
  const tdir = mkdtempSync(join(tmpdir(), "e7-c50-helpers-")); symlinkSync(join(TOOLING, "node_modules"), join(tdir, "node_modules"));
  const turl = (rel) => pathToFileURL(join(TOOLING, "test/db", rel)).href;
  let mod = text.slice(0, text.indexOf("// provider harness"));
  mod = mod.replace(/^import \{ test, before, after \} from "node:test";\n/m, "").replace(/^import assert from "node:assert\/strict";\n/m, 'import assert from "node:assert/strict";\n');
  mod = mod.replace(/from "(\.\.?\/[^"]+)"/g, (_, rel) => `from "${turl(rel)}"`);
  const guardStart = mod.indexOf("let netAttempts = 0;"); const guardEnd = mod.indexOf("syncBuiltinESMExports();", guardStart) + "syncBuiltinESMExports();".length;
  mod = mod.slice(0, guardStart) + "// (network guard of the source suite removed here: this test file installs its own guards)\n" + mod.slice(guardEnd);
  mod = mod.replace('let db;\nbefore(async () => { db = await startMigratedDatabase(); });\nafter(async () => { globalThis.fetch = realFetch; await db.close(); });', "let db; export const __setDb = (x) => { db = x; };");
  assert.ok(mod.includes("export const __setDb") && !/^(before|after|test)\(/m.test(mod), "helper module rewritten as reviewed (no node:test registration left)");
  mod += "\nexport { confirmedBooking, notifyOf, digest, ENV_N, SENDER, startMigratedDatabase, startPostgres, migrateUp, F };\n";
  writeFileSync(join(tdir, "helpers.mjs"), mod);
  const Hm = await import(pathToFileURL(join(tdir, "helpers.mjs")).href);
  const pg = createRequire(join(TOOLING, "package.json"))("pg");
  const T = { runNotificationStep: (await import(pathToFileURL(join(TOOLING, "lib/booking-db/notification-worker.js")).href)).runNotificationStep,
    createResendNotificationExecutor: (await import(pathToFileURL(join(TOOLING, "lib/notify/resend-notification-executor.js")).href)).createResendNotificationExecutor,
    NOTIFICATION_V2_OPTION_KEY: "confirmationLocale", NOTIFICATION_PROVIDER_OPTION_KEY: "providerExecutor" };
  // C119 S1: schema 27 = the pinned tooling's migrations + the MERGED e7-test 0027 bytes (sha-checked), in ONE disposable migrations dir
  const S27 = realpathSync(process.env.E7_SCHEMA27_DIR || join(ROOT, "..", "schema27"));
  const M27 = { "0027_external_cancellation_disposition.up.sql": "ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf",
    "0027_external_cancellation_disposition.down.sql": "8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c" };
  const MDIR = mkdtempSync(join(tmpdir(), "e7-c119-m27-"));
  for (const f of readdirSync(join(TOOLING, "db/migrations"))) writeFileSync(join(MDIR, f), readFileSync(join(TOOLING, "db/migrations", f)));
  assert.ok(!readdirSync(MDIR).some((f) => f.startsWith("0027_")), "the pinned tooling has no 0027");
  for (const [f, h] of Object.entries(M27)) { const b = readFileSync(join(S27, "db/migrations", f)); assert.equal(sha(b), h, `${f}: the merged e7-test 0027 bytes`); writeFileSync(join(MDIR, f), b); }
  const db = await Hm.startMigratedDatabase(); Hm.__setDb(db);
  assert.deepEqual(await Hm.migrateUp(db.owner, { env: "test", dir: MDIR }), [27], "0027 applied on top of the pinned 0001..0026");
  after(async () => { await db.close(); rmSync(tdir, { recursive: true, force: true }); rmSync(MDIR, { recursive: true, force: true }); });
  assert.deepEqual(Hm.SENDER, { fromAddress: "bookings@sender.mv-test.invalid", fromName: "maraVilla Test" }, "the accepted suites' synthetic sender is unchanged");
  const SI = await import(pathToFileURL(join(TOOLING, "lib/notify/sender-identity.js")).href);
  assert.deepEqual({ ...C.sender }, { ...SI.APPROVED_REAL_SENDER }, "C55: the runner's fixed sender == the pinned approved identity");
  const fingerprint = async () => (await db.owner.query(`SELECT jsonb_object_agg(t.relname, x.v) AS f FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace,
      LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(to_jsonb(x)::text, E''\\n'' ORDER BY to_jsonb(x)::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x
      WHERE s.nspname = 'booking' AND t.relkind = 'r'`)).rows[0].f;
  let seq = 0;
  const fakeExchange = (reply) => { const s = { calls: 0 }; s.exchange = async (req) => { s.calls += 1; seq += 1; return reply(`5f0c1a2b-3c4d-4e5f-8a6b-${String(seq).padStart(12, "0")}`, req); }; return s; };
  const H200 = { contentType: "application/json", contentEncoding: null, idempotentReplayed: null };
  const ok200 = (id) => ({ status: 200, headers: H200, body: Buffer.from(`{"id":"${id}"}`) });
  const run = async (bk, opId, locale, fx, over = {}) => {
    const c = { ...OPEN, listingId: bk.listingId, ...over.c };
    const plan = R.buildPlan(c, { approvalRef: "label-db", intentId: over.intentId ?? bk.id, opId, expectedVersion: over.version ?? bk.version, locale, sourceDigest: "a".repeat(64) }).plan;
    return R.runBookingConfirmationCore({ pool: over.pool ?? db.app, plan, c, tooling: T, exchange: fx.exchange, credential: () => KEY, runId: "123456789-1" });
  };
  const ready = async (opts) => { const bk = await Hm.confirmedBooking(opts); const v = (await db.owner.query("SELECT version FROM booking.intents WHERE id = $1", [bk.id])).rows[0].version; return { ...bk, version: v }; };

  const identityAt = async (to) => {   // the runner's OWN catalog query as the runtime app role on a fresh disposable cluster migrated to `to`
    const p = await Hm.startPostgres(); const a = new pg.Client({ connectionString: p.adminUrl }); await a.connect();
    try {
      await Hm.migrateUp(a, { env: "test", to, dir: MDIR }); await a.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
      const c = new pg.Client({ connectionString: p.appUrl() }); await c.connect();
      try { await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const id = (await c.query(R.CATALOG_SQL, [[...R.READ_PATH_FUNCTIONS]])).rows[0].id; await c.query("ROLLBACK");
        const sections = {}; for (const k of ["con", "col", "fn", "pol", "rel", "trg"]) sections[k] = id.sections[k] ?? null;
        return { catalog: sha(R.canonical(sections)), readPath: id.readPath, readPathCount: id.readPathCount, sections };
      } finally { await c.end(); }
    } finally { await a.end(); p.stop(); }
  };
  test("D0 C119 schema-27 pin DERIVED, not copied: the runner's catalog query (7-function read path) as the runtime app role on THIS PostgreSQL reproduces the accepted schema-23 inspector pin and the C116 schema-26 pin byte-for-byte, yields EXACTLY CONSTANTS.catalogPin27 at 27 (== the #189 POST-27 catalog; the read path now covers the 0027 projection), and schema-26 / schema-25 clusters are each refused CATALOG_NOT_27 before any worker / exchange", async () => {
    const I = await import("../scripts/e7-hosted-notify-inspect.mjs");
    assert.deepEqual(await identityAt(23), I.CONSTANTS.catalogPins["23"], "the derivation reproduces the accepted schema-23 pin");
    assert.deepEqual(await identityAt(26), PIN26, "the derivation reproduces the C116 schema-26 pin (the projection does not exist at 26)");
    const i27 = await identityAt(27);
    assert.deepEqual(i27, C.catalogPin27, "the pinned schema-27 identity"); assert.equal(i27.catalog, POST27_CATALOG);
    assert.deepEqual([i27.readPathCount, i27.readPath !== PIN26.readPath], [7, true], "the read path covers booking.external_cancellation_public");
    for (const to of [26, 25]) {
      const p = await Hm.startPostgres(); const a = new pg.Client({ connectionString: p.adminUrl }); await a.connect();
      try {
        await Hm.migrateUp(a, { env: "test", to, dir: MDIR }); await a.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
        const app = new pg.Pool({ connectionString: p.appUrl(), max: 2 }); const bk = await ready(); const fx = fakeExchange(ok200);
        try {
          const r = await run(bk, bk.op.id, "en", fx, { pool: app }); assert.deepEqual([r.code, r.admission, r.workerInvocations, fx.calls], ["NBC_ADMISSION_REFUSED", "CATALOG_NOT_27", 0, 0], `schema ${to}`);
          const d = await R.runDetectCore({ pool: app, c: { ...OPEN, listingId: bk.listingId }, sourceDigest: "a".repeat(64) });
          assert.deepEqual([d.outcome, d.code, d.fingerprint], ["STOP", "DETECT_SESSION_REFUSED", null], `detect at schema ${to}`);
        } finally { await app.end(); }
      } finally { await a.end(); p.stop(); }
    }
  });

  test("D7 C116 the EXACT simulation sink on the FAKE wire (real PG27, real worker / executor at 66133a22): a guest stored as delivered@resend.dev is admitted (class ELIGIBLE) → ONE fake 200 → PROVIDER_ACCEPTED + VERIFIED readback; wire `to` === [the stored email] (no rewrite); a rerun is refused OP_NOT_PRISTINE with ZERO calls; a look-alike guest is CLASS_NOT_ELIGIBLE with ZERO calls and no table change", async () => {
    const bk = await ready({ guestEmail: "delivered@resend.dev" }); const reqs = [];
    const stored = (await db.owner.query("SELECT email FROM booking.intent_guests WHERE intent_id = $1", [bk.id])).rows[0].email;
    assert.equal(stored === "delivered@resend.dev", true);
    const fx = fakeExchange((id, req) => { reqs.push(req); return ok200(id); });
    const r = await run(bk, bk.op.id, "en", fx);
    assert.deepEqual([r.code, r.admission, r.verifiedCompletion, r.readback, fx.calls, r.deliveryProven], ["PROVIDER_ACCEPTED", "ADMITTED", true, "VERIFIED", 1, false]);
    const wire = JSON.parse(Buffer.from(reqs[0].body).toString("utf8"));
    assert.equal(JSON.stringify(wire.to) === JSON.stringify([stored]), true, "wire recipient === the stored guest email (the sink)");
    assert.equal(wire.from, "MiCasaDirect <bookings@mail.micasadirect.com>");
    assert.doesNotMatch(JSON.stringify(r), PII);
    const fx2 = fakeExchange(ok200); const again = await run(bk, bk.op.id, "en", fx2);
    assert.deepEqual([again.code, again.admission, again.workerInvocations, fx2.calls], ["NBC_ADMISSION_REFUSED", "OP_NOT_PRISTINE", 0, 0]);
    const look = await ready({ guestEmail: "delivered+x@resend.dev" }); const f0 = await fingerprint(); const fx3 = fakeExchange(ok200);
    const lr = await run(look, look.op.id, "en", fx3);
    assert.deepEqual([lr.code, lr.admission, lr.workerInvocations, fx3.calls], ["NBC_ADMISSION_REFUSED", "CLASS_NOT_ELIGIBLE", 0, 0]);
    assert.deepEqual(await fingerprint(), f0, "no table change for the refused look-alike");
  });

  test("D1 execute body (seam) on disposable PG27 — EN: admission → ONE real worker invocation → ONE fake 200 → PROVIDER_ACCEPTED; durable succeeded / resend ref / ONE receipt / gn-v2 en render; a rerun (fresh executor) is refused at admission with ZERO exchange calls (durable no-resend)", async () => {
    const bk = await ready(); const fx = fakeExchange(ok200);
    const r = await run(bk, bk.op.id, "en", fx);
    assert.deepEqual([r.code, r.admission, r.workerOutcome, r.workerInvocations, r.sendsAttempted, fx.calls, r.providerAccepted, r.providerReplay, r.deliveryProven], ["PROVIDER_ACCEPTED", "ADMITTED", "accepted", 1, 1, 1, true, false, false], JSON.stringify(r));
    assert.deepEqual(r.postcheck, { state: "succeeded", attempts: 1, resendRef: true, errorCode: null, receipts: 1, replayed: false, templateVersion: "gn-v2", locale: "en" });
    assert.deepEqual([r.verifiedCompletion, r.readback], [true, "VERIFIED"]);
    assert.doesNotMatch(JSON.stringify(r), PII); assert.ok(r.statements > 0 && r.statements <= C.budgets.statements);
    const fx2 = fakeExchange(ok200); const again = await run(bk, bk.op.id, "en", fx2);
    assert.deepEqual([again.code, again.admission, again.workerInvocations, fx2.calls], ["NBC_ADMISSION_REFUSED", "OP_NOT_PRISTINE", 0, 0]);
  });

  test("D2 execute body (seam) — ES: a fake 500 → the worker's durable UNKNOWN (outcome_unknown, no receipt) → UNKNOWN_STOP; ONE exchange call; a rerun is refused at admission with ZERO calls", async () => {
    const bk = await ready(); const fx = fakeExchange(() => ({ status: 500, headers: H200, body: Buffer.from("SENTINEL") }));
    const r = await run(bk, bk.op.id, "es", fx);
    assert.deepEqual([r.code, r.workerOutcome, r.workerCode, fx.calls, r.providerAccepted], ["UNKNOWN_STOP", "unknown", "HTTP_STATUS", 1, false]);
    assert.deepEqual([r.postcheck.state, r.postcheck.receipts, r.postcheck.resendRef, r.postcheck.errorCode, r.postcheck.locale], ["outcome_unknown", 0, false, "HTTP_STATUS", "es"]);
    const fx2 = fakeExchange(ok200); const again = await run(bk, bk.op.id, "es", fx2);
    assert.deepEqual([again.code, again.admission, fx2.calls], ["NBC_ADMISSION_REFUSED", "OP_NOT_PRISTINE", 0]); assert.doesNotMatch(JSON.stringify(r) + JSON.stringify(again), PII);
  });

  test("D3 binding refusals on real PG27 leave EVERY booking table unchanged with ZERO exchange calls: wrong version / foreign op / excluded intent id / out-of-scope (.example) recipient / owner role / foreign listing; a schema-21 database → CATALOG_NOT_27", async () => {
    const bk = await ready(); const out = await ready({ guestDomain: "mv-test.example" });
    const f0 = await fingerprint();
    const ownerPool = new pg.Pool({ connectionString: db.adminUrl, max: 2 });
    try {
      const cases = [[await run(bk, bk.op.id, "en", fakeExchange(ok200), { version: bk.version + 1 }), "VERSION_MISMATCH"],
        [await run(bk, "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", "en", fakeExchange(ok200)), "OP_NOT_BOUND"],
        [await run(bk, bk.op.id, "en", fakeExchange(ok200), { intentId: "abede8b1-8ef6-44f2-876e-6a02fc056a96" }), "INTENT_EXCLUDED"],
        [await run(out, out.op.id, "es", fakeExchange(ok200)), "CLASS_NOT_ELIGIBLE"],
        [await run(bk, bk.op.id, "en", fakeExchange(ok200), { pool: ownerPool }), "ROLE_REFUSED"],
        [await run(bk, bk.op.id, "en", fakeExchange(ok200), { c: { listingId: 606998 } }), "LISTING_MISMATCH"]];
      for (const [res, code] of cases) assert.deepEqual([res.code, res.admission, res.workerInvocations, res.sendsAttempted], ["NBC_ADMISSION_REFUSED", code, 0, 0], code);
    } finally { await ownerPool.end(); }
    assert.deepEqual(await fingerprint(), f0, "no booking / notification / lease / claim / render / latch / receipt / inbox change on any refusal");
    const p21 = await Hm.startPostgres(); const a21 = new pg.Client({ connectionString: p21.adminUrl }); await a21.connect();
    try {
      await Hm.migrateUp(a21, { env: "test", to: 21, dir: MDIR }); await a21.query("CREATE ROLE test_app LOGIN IN ROLE mv_booking_app");
      const app21 = new pg.Pool({ connectionString: p21.appUrl(), max: 2 });
      try { const r = await run(bk, bk.op.id, "en", fakeExchange(ok200), { pool: app21 }); assert.deepEqual([r.code, r.admission], ["NBC_ADMISSION_REFUSED", "CATALOG_NOT_27"]); } finally { await app21.end(); }
    } finally { await a21.end(); p21.stop(); }
  });

  /** db.app with ONLY the final readback faulted (thrown or dropped); every other statement — admission, the real worker, its SQL — is untouched */
  const faultReadback = (mode) => ({ query: (t, p) => db.app.query(t, p), connect: async () => { const cl = await db.app.connect();
    return { query: (t, p) => (t === R.POSTCHECK_QUERY ? (mode === "throw" ? Promise.reject(new Error("SENTINEL readback fault")) : Promise.resolve({ rows: [] })) : cl.query(t, p)), release: (d) => cl.release(d) }; } });

  test("D4 C51 a real durable ACCEPTED completion whose final readback is faulted (thrown / dropped) → ACCEPTED_UNVERIFIED_STOP with acceptance retained and ONE provider call; the operation / receipt really are succeeded / 1; a rerun is refused at admission with ZERO calls", async () => {
    for (const [mode, rb] of [["throw", "UNAVAILABLE"], ["drop", "MISSING"]]) {
      const bk = await ready(); const fx = fakeExchange(ok200);
      const r = await run(bk, bk.op.id, mode === "throw" ? "en" : "es", fx, { pool: faultReadback(mode) });
      assert.deepEqual([r.code, r.readback, r.verifiedCompletion, r.providerAccepted, r.workerOutcome, r.sendsAttempted, fx.calls, r.postcheck], ["ACCEPTED_UNVERIFIED_STOP", rb, false, true, "accepted", 1, 1, null], mode);
      const op = (await db.owner.query("SELECT state, attempts, result_ref LIKE 'resend:%' AS rr FROM booking.external_operations WHERE id = $1", [bk.op.id])).rows[0];
      const rc = Number((await db.owner.query("SELECT count(*) AS n FROM booking.notification_provider_receipts WHERE operation_id = $1", [bk.op.id])).rows[0].n);
      assert.deepEqual([op.state, op.attempts, op.rr, rc], ["succeeded", 1, true, 1], "the acceptance is durable; only the readback failed");
      const fx2 = fakeExchange(ok200); const again = await run(bk, bk.op.id, "en", fx2);
      assert.deepEqual([again.code, again.admission, again.workerInvocations, fx2.calls], ["NBC_ADMISSION_REFUSED", "OP_NOT_PRISTINE", 0, 0], "never a permission to resend");
      assert.doesNotMatch(JSON.stringify(r), PII);
    }
  });

  test("D5 C51 the documented class-ELIGIBLE-but-SQL-refused path on real PG27 (source version drift): admission passes (class ELIGIBLE), the accepted worker's v2 claim records its refusal → NOT_SENT with ZERO provider calls — and NOT zero database effects: exactly ONE durable effect, the latch VERSION_DRIFT; the op stays pending / attempts 0, no render / receipt", async () => {
    const bk = await ready();
    await Hm.F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET version = version + 1 WHERE id = $1", [bk.id]);   // TEST SETUP: intent version ≠ op source_version
    const v = (await db.owner.query("SELECT version FROM booking.intents WHERE id = $1", [bk.id])).rows[0].version;
    const f0 = await fingerprint(); const fx = fakeExchange(ok200);
    const r = await run(bk, bk.op.id, "en", fx, { version: v });
    assert.equal(r.admission, "ADMITTED", "the runtime role cannot pre-check the owner-only refusal detail");
    assert.deepEqual([r.code, fx.calls, r.sendsAttempted, r.providerAccepted, r.verifiedCompletion], ["NOT_SENT", 0, 0, false, false], JSON.stringify(r));
    assert.deepEqual([r.workerOutcome, r.workerCode], ["latched", "VERSION_DRIFT"]);
    const latch = (await db.owner.query("SELECT code FROM booking.notification_latches WHERE operation_id = $1", [bk.op.id])).rows[0];
    const f1 = await fingerprint();
    assert.notDeepEqual(f1, f0, "NOT_SENT is not 'no database effect'");
    const changed = Object.keys(f1).filter((k) => f1[k] !== f0[k]).sort();
    assert.deepEqual(changed, ["notification_latches"], "exactly ONE durable effect: the accepted claim's latch (the worker released its own work lease)");
    assert.equal(latch.code, "VERSION_DRIFT");
    assert.deepEqual(r.postcheck, { state: "pending", attempts: 0, resendRef: false, errorCode: null, receipts: 0, replayed: false, templateVersion: null, locale: null });
    assert.equal(r.readback, "NOT_REQUIRED");
    assert.equal(Number((await db.owner.query("SELECT count(*) AS n FROM booking.notification_renders WHERE operation_id = $1", [bk.op.id])).rows[0].n), 0, "no render: nothing was claimed");
    assert.equal(Number((await db.owner.query("SELECT count(*) AS n FROM booking.notification_provider_receipts WHERE operation_id = $1", [bk.op.id])).rows[0].n), 0);
    assert.doesNotMatch(JSON.stringify(r), PII);
  });

  test("D6 C55 the exact approved sender on the FAKE wire (real PG27, real worker / executor at 66133a22): from === 'MiCasaDirect <bookings@mail.micasadirect.com>', recipient still the DB's .invalid address; the superseded real sender (seam) is refused before any claim with ZERO exchange calls and no table change", async () => {
    const bk = await ready(); const reqs = [];
    const fx = fakeExchange((id, req) => { reqs.push(req); return ok200(id); });
    const r = await run(bk, bk.op.id, "en", fx);
    assert.deepEqual([r.code, r.verifiedCompletion, fx.calls], ["PROVIDER_ACCEPTED", true, 1]);
    const wire = JSON.parse(Buffer.from(reqs[0].body).toString("utf8"));
    assert.equal(wire.from, "MiCasaDirect <bookings@mail.micasadirect.com>");
    assert.equal(wire.to.length, 1); assert.match(wire.to[0], /^[a-z0-9._+-]+@([a-z0-9-]+\.)+invalid$/, "recipient scope unchanged (.invalid only)");
    assert.doesNotMatch(JSON.stringify(r), PII);
    const bk2 = await ready(); const f0 = await fingerprint();
    for (const sender of [{ fromAddress: "bookings@mail.maravillanayarit.com", fromName: "maraVilla" }, { fromAddress: "Bookings@mail.micasadirect.com", fromName: "MiCasaDirect" },
      { fromAddress: "bookings@mail.micasadirect.com", fromName: "micasadirect" }]) {
      const fx2 = fakeExchange(ok200); const bad = await run(bk2, bk2.op.id, "en", fx2, { c: { sender } });
      assert.deepEqual([bad.code, bad.admission, bad.workerInvocations, bad.sendsAttempted, fx2.calls], ["NBC_EXECUTOR_INVALID", "ADMITTED", 0, 0, 0], JSON.stringify(sender));
    }
    assert.deepEqual(await fingerprint(), f0, "no table change for a refused sender");
  });
  // ---- C119 S1 on REAL PG27: detect + detect-flow execute (real worker / builder / executor at 66133a22; FAKE exchange only) --------------------
  const SRC_A = "a".repeat(64);
  const cOf = (listingId, over = {}) => ({ ...OPEN, listingId, ...over });
  const detect = (listingId, { pool = db.app, c = {} } = {}) => R.runDetectCore({ pool, c: cOf(listingId, c), sourceDigest: SRC_A });
  const dexec = (listingId, fp, fx, { pool = db.app } = {}) => R.runBookingConfirmationCore({ pool, plan: null, c: cOf(listingId), tooling: T, exchange: fx.exchange, credential: () => KEY,
    runId: "123456789-1", detected: { expectedFingerprint: fp, sourceDigest: SRC_A } });
  /** the owner's REAL 0027 path (admin login): one owner-attested dashboard observation + the record (refund pending) */
  const cancelExternally = async (bk) => {
    const res = (await db.owner.query("SELECT hostaway_reservation_id AS r, version AS v FROM booking.intents WHERE id = $1", [bk.id])).rows[0];
    const ev = (await db.reconciler.query("SELECT booking.admin_record_evidence($1,$2,$3,$4,$5,$6,$7,$8) AS id",
      [bk.id, "hostaway_reservation", String(res.r), "cancelled", {}, new Date(), "owner", "hostaway-dashboard-cancelled"])).rows[0].id;
    return (await db.reconciler.query("SELECT booking.admin_record_external_cancellation($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$11) AS r",
      [bk.id, res.v, [ev], ev, "pending", null, null, "owner", "hostaway-dash-check-c119", "OWNER_CANCELLED_IN_HOSTAWAY", `c119-${bk.id.slice(0, 8)}`])).rows[0].r;
  };
  const noIds = (r, ...bks) => { const t = JSON.stringify(r); for (const b of bks) { assert.ok(!t.includes(b.id) && !t.includes(b.op.id), "no intent / op id in the result"); } assert.doesNotMatch(t, PII); };

  test("D8 C119 detect → ONE → detect-flow execute on REAL PG27: detect writes NOTHING (every booking table identical) and outputs no identifier; the execute re-selects, matches the fingerprint and makes ONE real worker invocation → ONE fake 200 → PROVIDER_ACCEPTED + VERIFIED; afterwards detect → NONE (SUCCEEDED is terminal), the SAME fingerprint replayed → NBC_CANDIDATE_CHANGED with ZERO calls, and the manual path is refused OP_NOT_PRISTINE (already sent)", async () => {
    const bk = await ready(); const f0 = await fingerprint();
    const d = await detect(bk.listingId);
    assert.deepEqual([d.outcome, d.code, d.admission, d.counts.eligible, d.counts.attention], ["ONE", "DETECT_ONE", "ADMITTED", 1, 0], JSON.stringify(d));
    assert.equal(d.fingerprint, R.detectPlan(cOf(bk.listingId), { intentId: bk.id, opId: bk.op.id, version: bk.version }, SRC_A).planHash, "fingerprint == the server-derived plan hash");
    assert.deepEqual(await fingerprint(), f0, "detect is read-only"); noIds(d, bk);
    const fx = fakeExchange(ok200); const r = await dexec(bk.listingId, d.fingerprint, fx);
    assert.deepEqual([r.flow, r.detectCode, r.code, r.admission, r.workerInvocations, fx.calls, r.verifiedCompletion, r.readback], ["detect", "DETECT_ONE", "PROVIDER_ACCEPTED", "ADMITTED", 1, 1, true, "VERIFIED"]);
    assert.deepEqual([r.postcheck.state, r.postcheck.receipts, r.postcheck.templateVersion, r.postcheck.locale], ["succeeded", 1, "gn-v2", "en"]); noIds(r, bk);
    const again = await detect(bk.listingId); assert.deepEqual([again.outcome, again.code, again.counts.terminal], ["NONE", "DETECT_NONE", 1]);
    const fx2 = fakeExchange(ok200); const replay = await dexec(bk.listingId, d.fingerprint, fx2);
    assert.deepEqual([replay.code, replay.detectCode, replay.workerInvocations, fx2.calls], ["NBC_CANDIDATE_CHANGED", "DETECT_NONE", 0, 0], "never a resend");
    const fx3 = fakeExchange(ok200); const manual = await run(bk, bk.op.id, "en", fx3);
    assert.deepEqual([manual.admission, fx3.calls], ["OP_NOT_PRISTINE", 0]);
  });

  test("D9 C119 more than ONE eligible on the listing → STOP DETECT_MORE_THAN_ONE (explicit capacity limitation of this TEST slice, never a pick), ZERO table changes; a detect-flow execute with any fingerprint → NBC_CANDIDATE_CHANGED with ZERO calls; a historic cutoff makes every row historic → NONE", async () => {
    const a = await ready(); const b = await ready({ listingId: a.listingId }); const f0 = await fingerprint();
    const d = await detect(a.listingId);
    assert.deepEqual([d.outcome, d.code, d.fingerprint, d.counts.eligible], ["STOP", "DETECT_MORE_THAN_ONE", null, 2]); noIds(d, a, b);
    for (const fp of [R.detectPlan(cOf(a.listingId), { intentId: a.id, opId: a.op.id, version: a.version }, SRC_A).planHash, R.detectPlan(cOf(a.listingId), { intentId: b.id, opId: b.op.id, version: b.version }, SRC_A).planHash]) {
      const fx = fakeExchange(ok200); const r = await dexec(a.listingId, fp, fx); assert.deepEqual([r.code, r.detectCode, r.workerInvocations, fx.calls], ["NBC_CANDIDATE_CHANGED", "DETECT_MORE_THAN_ONE", 0, 0]);
    }
    const future = await detect(a.listingId, { c: { detect: { ...OPEN.detect, cutoff: "2099-01-01T00:00:00.000Z" } } });
    assert.deepEqual([future.outcome, future.counts.historic, future.counts.historicUnresolved], ["NONE", 2, 2], "historic rows are counted (visible) and never selected");
    assert.deepEqual(await fingerprint(), f0, "nothing written");
  });

  test("D10 C119 external cancellation BEFORE detect (the REAL 0027 admin path; the pristine notify is latched EXTERNALLY_CANCELLED): the runtime role reads the granted projection as cancelled; detect → NONE (LATCHED is terminal); the manual path is refused EXTERNALLY_CANCELLED at admission; ZERO exchange calls; no table changed by any of them", async () => {
    const bk = await ready(); const rec = await cancelExternally(bk);
    assert.ok(rec, "recorded");
    assert.deepEqual((await db.app.query("SELECT booking.external_cancellation_public($1::uuid) AS x", [bk.id])).rows[0].x, { cancelled: true, refundStatus: "pending" });
    const f0 = await fingerprint();
    const d = await detect(bk.listingId); assert.deepEqual([d.outcome, d.code, d.counts.terminal, d.counts.eligible], ["NONE", "DETECT_NONE", 1, 0], JSON.stringify(d));
    const fx = fakeExchange(ok200); const m = await run(bk, bk.op.id, "en", fx);
    assert.deepEqual([m.code, m.admission, m.workerInvocations, fx.calls], ["NBC_ADMISSION_REFUSED", "EXTERNALLY_CANCELLED", 0, 0]);
    assert.deepEqual(await fingerprint(), f0);
  });

  test("D11 C119 external cancellation BETWEEN detect and execute: the detect-flow execute re-selects (the op is now latched) → NBC_CANDIDATE_CHANGED with ZERO worker invocations / calls; a manual plan for the same op → EXTERNALLY_CANCELLED at admission; the notification stays unsent", async () => {
    const bk = await ready(); const d = await detect(bk.listingId); assert.equal(d.outcome, "ONE");
    await cancelExternally(bk);
    const fx = fakeExchange(ok200); const r = await dexec(bk.listingId, d.fingerprint, fx);
    assert.deepEqual([r.code, r.detectCode, r.workerInvocations, fx.calls], ["NBC_CANDIDATE_CHANGED", "DETECT_NONE", 0, 0]);
    const fx2 = fakeExchange(ok200); const m = await run(bk, bk.op.id, "en", fx2);
    assert.deepEqual([m.admission, fx2.calls], ["EXTERNALLY_CANCELLED", 0]);
    const op = (await db.owner.query("SELECT state, attempts FROM booking.external_operations WHERE id = $1", [bk.op.id])).rows[0];
    assert.deepEqual([op.state, op.attempts], ["pending", 0], "never sent");
  });

  test("D12 C119 fact drift after detect: (a) SAME intent version, guest recipient moved out of the sink / .invalid scope → the class is OUT_OF_V1_SCOPE: execute → NBC_CANDIDATE_CHANGED (re-select STOPs on attention), ZERO calls; (b) version drift (the D5 setup) → the fingerprint no longer matches → NBC_CANDIDATE_CHANGED, ZERO calls", async () => {
    const a = await ready(); const d = await detect(a.listingId); assert.equal(d.outcome, "ONE");
    const v0 = (await db.owner.query("SELECT version FROM booking.intents WHERE id = $1", [a.id])).rows[0].version;
    await Hm.F.ownerManagedHistory(db.owner, "UPDATE booking.intent_guests SET email = $2 WHERE intent_id = $1", [a.id, "guest.drift@mv-test.example"]);   // TEST SETUP
    assert.equal((await db.owner.query("SELECT version FROM booking.intents WHERE id = $1", [a.id])).rows[0].version, v0, "same version");
    const fx = fakeExchange(ok200); const r = await dexec(a.listingId, d.fingerprint, fx);
    assert.deepEqual([r.code, r.detectCode, r.workerInvocations, fx.calls], ["NBC_CANDIDATE_CHANGED", "DETECT_ATTENTION", 0, 0]);
    const b = await ready(); const db0 = await detect(b.listingId); assert.equal(db0.outcome, "ONE");
    await Hm.F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET version = version + 1 WHERE id = $1", [b.id]);   // TEST SETUP (as D5)
    const fx2 = fakeExchange(ok200); const r2 = await dexec(b.listingId, db0.fingerprint, fx2);
    assert.deepEqual([r2.code, r2.detectCode, r2.workerInvocations, fx2.calls], ["NBC_CANDIDATE_CHANGED", "DETECT_ONE", 0, 0], "re-selected, but the version moved: a different fingerprint");
  });

  test("D13 C119 two COMPETING detect / execute runs for the SAME candidate (both detect ONE, both execute concurrently with the same fingerprint): exactly ONE provider acceptance in total and the loser never reaches the exchange (the accepted worker's claim / lease fences are the authority, not detect)", async () => {
    const bk = await ready(); const d1 = await detect(bk.listingId); const d2 = await detect(bk.listingId);
    assert.deepEqual([d1.outcome, d2.outcome, d1.fingerprint === d2.fingerprint], ["ONE", "ONE", true]);
    const fa = fakeExchange(ok200); const fb = fakeExchange(ok200);
    const [ra, rb] = await Promise.all([dexec(bk.listingId, d1.fingerprint, fa), dexec(bk.listingId, d2.fingerprint, fb)]);
    assert.equal(fa.calls + fb.calls, 1, `exactly ONE exchange call in total: ${ra.code}/${ra.admission}/${ra.workerOutcome} vs ${rb.code}/${rb.admission}/${rb.workerOutcome}`);
    assert.deepEqual([ra, rb].filter((x) => x.code === "PROVIDER_ACCEPTED").length, 1);
    const loser = [ra, rb].find((x) => x.code !== "PROVIDER_ACCEPTED"); assert.equal(loser.sendsAttempted, 0);
    const rc = Number((await db.owner.query("SELECT count(*) AS n FROM booking.notification_provider_receipts WHERE operation_id = $1", [bk.op.id])).rows[0].n); assert.equal(rc, 1);
  });

  test("D14 C119 unreadable cancellation projection: (a) runtime EXECUTE revoked (test-local) → the fn ACL is part of the catalog → detect STOP DETECT_SESSION_REFUSED and execute CATALOG_NOT_27; (b) a thrown / malformed / non-NULL-non-cancelled projection reply on the REAL path → CANCELLATION_UNREADABLE (detect DETECT_NOT_ADMISSIBLE; execute refused) — never read as 'not cancelled'; ZERO calls throughout", async () => {
    const bk = await ready();
    await db.owner.query("REVOKE EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) FROM mv_booking_app");
    try {
      const d = await detect(bk.listingId); assert.deepEqual([d.outcome, d.code], ["STOP", "DETECT_SESSION_REFUSED"]);
      const fx = fakeExchange(ok200); const m = await run(bk, bk.op.id, "en", fx); assert.deepEqual([m.admission, fx.calls], ["CATALOG_NOT_27", 0]);
    } finally { await db.owner.query("GRANT EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) TO mv_booking_app"); }
    assert.equal((await detect(bk.listingId)).outcome, "ONE", "restored");
    const QX = R.ADMISSION_QUERIES.cancellation;
    const faulty = (reply) => ({ query: (t, p) => db.app.query(t, p), connect: async () => { const cl = await db.app.connect();
      return { query: (t, p) => (t === QX ? reply(cl, p) : cl.query(t, p)), release: (x) => cl.release(x) }; } });
    for (const [why, reply] of [["thrown", () => Promise.reject(new Error("permission denied for function external_cancellation_public"))], ["no row", () => Promise.resolve({ rows: [] })],
      ["string", () => Promise.resolve({ rows: [{ x: "null" }] })], ["not cancelled object", () => Promise.resolve({ rows: [{ x: { cancelled: false } }] })], ["two rows", (cl, p) => cl.query(`${QX} UNION ALL ${QX}`, [...p, ...p].slice(0, 1))]]) {
      const d = await R.runDetectCore({ pool: faulty(reply), c: cOf(bk.listingId), sourceDigest: SRC_A });
      assert.deepEqual([d.outcome, d.code, d.admission, d.fingerprint], ["STOP", "DETECT_NOT_ADMISSIBLE", "CANCELLATION_UNREADABLE", null], why);
      const fx = fakeExchange(ok200); const m = await run(bk, bk.op.id, "en", fx, { pool: faulty(reply) });
      assert.deepEqual([m.code, m.admission, m.workerInvocations, fx.calls], ["NBC_ADMISSION_REFUSED", "CANCELLATION_UNREADABLE", 0, 0], why);
    }
  });

}
