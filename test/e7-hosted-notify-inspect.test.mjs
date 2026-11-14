// test/e7-hosted-notify-inspect.test.mjs — C47: the hosted READ-ONLY notification admission inspection (scripts/e7-hosted-notify-inspect.mjs).
// Always-on part: FAKE database clients (every statement must be one of the runner's fixed QUERIES), fake hosted seams, fake credentials, and
// throwing network guards. OPT-IN part (E7_HNI_DB_TESTS=1; PG_BIN; E7_TOOLING_DIR = the pinned d322d219 checkout with its pinned pg): REAL disposable
// PostgreSQL at schema 21 / 22 / 23 built with the tooling's accepted migrator + fixtures, read as the RUNTIME APP ROLE; proves the catalog pins,
// the read-only read path, the read-only transaction, truthful classes (the real-style out-of-scope recipient is NOT eligible) and ZERO mutation.
// The hosted preflight child never sets E7_HNI_DB_TESTS. Nothing here touches a shared database, a provider or the network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import net from "node:net";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { https: 0, http: 0, fetch: 0, connect: 0 };
https.request = () => { GUARD.https += 1; throw new Error("network refused"); };
https.get = () => { GUARD.https += 1; throw new Error("network refused"); };
https.Agent = class { constructor() { GUARD.https += 1; throw new Error("network refused"); } };
http.request = () => { GUARD.http += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
const DB_TESTS = process.env.E7_HNI_DB_TESTS === "1";
if (!DB_TESTS) { const realConnect = net.connect; net.connect = net.createConnection = (...a) => { GUARD.connect += 1; throw new Error("network refused"); }; void realConnect; }
syncBuiltinESMExports();
after(() => { assert.deepEqual(GUARD, { https: 0, http: 0, fetch: 0, connect: 0 }, "no network primitive was touched"); });

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const R = await import("../scripts/e7-hosted-notify-inspect.mjs");
const C = R.CONSTANTS; const Q = R.QUERIES;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const IID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607"; const OID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d"; const VER = 9;
const PLAN = R.buildPlan(C, { approvalRef: "label-c47", intentId: IID, opId: OID, expectedVersion: VER, sourceDigest: "a".repeat(64) }).plan;
const PII = /SENTINEL|sentinel|@|Zanabria|Quintessa|\+52|FAKEPW|re_|Bearer/;

// ---- fake database ---------------------------------------------------------------------------------------------------------------------------
const pin = (v) => C.catalogPins[String(v)];
function world(over = {}) {
  return { role: { ro: "on", iso: "repeatable read", who: "mv_booking_app_dev", su: false, app: true, adm: false, rep: false, own: false }, schema: 21,
    instance: { n: 1, env: "test" },
    intent: [{ id: IID, state: "confirmed", version: VER, listing_id: 606998, currency: "USD", has_reservation: true, protected_reservation: false, email: "SENTINEL@example.test", first_name: "SENTINEL" }],
    op: [{ id: OID, intent_id: IID, op_type: "guest.notify", state: "pending", attempts: 0, source_version: VER, dispatched: false, leased: false, completed: false, error_code: null,
      has_result: false, template: "booking_confirmed", payload_keys: ["template"], protected_payload: false, payload: { recipient: "SENTINEL@example.test" } }],
    pages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", state: "pending", class: "ELIGIBLE", code: null, recipient: "SENTINEL@example.test" }]],
    render: [], latch: [], receipts: { n: 0, any_replayed: false }, throwAt: null, hangAt: null, rollbackFails: false, ...over };
}
function fakeClient(w) {
  const log = []; let page = 0;
  return { log, async query(text, params) {
    const key = Object.keys(Q).find((k) => Q[k] === text);
    log.push(key ?? `UNLISTED:${text.slice(0, 40)}`);
    if (!key) throw new Error("unlisted SQL");
    if (key === "rollback" && w.rollbackFails) throw new Error("SENTINEL rollback");
    if (w.throwAt === key) throw Object.assign(new Error("SENTINEL db error zq@example.test password=FAKEPW"), { code: "XX000" });
    if (w.hangAt === key) return new Promise(() => {});
    switch (key) {
      case "begin": case "rollback": return { rows: [] };
      case "bounds": return { rows: [{ s: params[0], l: params[1], i: params[2] }] };
      case "role": return { rows: [w.role] };
      case "catalog": { const p = w.catalogOverride ?? pin(w.schema); return { rows: [{ id: { sections: p.sections, readPath: p.readPath, readPathCount: p.readPathCount } }] }; }
      case "instance": return { rows: [w.instance] };
      case "intent": return { rows: w.intent };
      case "op": return { rows: w.op };
      case "page": { const rows = w.pages[page] ?? []; page += 1; return { rows }; }
      case "render": return { rows: w.render };
      case "latch": return { rows: w.latch };
      case "receipts": return { rows: [w.receipts] };
      default: throw new Error("unreachable");
    }
  } };
}
const inspect = (w, c = C, plan = PLAN) => { const client = fakeClient(w); return R.inspectNotification({ client, plan, c }).then((res) => ({ res, log: client.log })); };
const HAPPY21 = ["begin", "bounds", "role", "catalog", "instance", "intent", "op", "page", "render", "latch", "rollback"];

test("N1 surface: inert frozen constants; NO execute / send mode (executeEnabled / sendEnabled false; modes preflight / verify / inspect only); every fixed statement is BEGIN … READ ONLY / SELECT / ROLLBACK; no mutating or claiming function, lock, sequence or notification module anywhere in the runner", async () => {
  assert.ok(Object.isFrozen(C) && Object.isFrozen(C.budgets) && Object.isFrozen(C.catalogPins) && Object.isFrozen(Q));
  assert.deepEqual([C.executeEnabled, C.sendEnabled, C.toolingStatus, C.toolingCommit, C.listingId, C.pgVersion], [false, false, "MERGED", "d322d2192b377d18b6a9280ae06c17eddfe3e73e", 606998, "8.18.0"]);
  assert.deepEqual(Object.keys(C.catalogPins).sort(), ["21", "22", "23"]);
  assert.equal(new Set(Object.values(C.catalogPins).map((p) => p.catalog)).size, 3, "three distinct reviewed identities");
  for (const [k, v] of Object.entries(Q)) {
    if (k === "begin") assert.equal(v, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    else if (k === "rollback") assert.equal(v, "ROLLBACK");
    else assert.match(v, /^SELECT /, k);
    assert.doesNotMatch(v, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|CALL|LOCK|GRANT|REVOKE|CREATE|ALTER|DROP|COMMIT|nextval|setval|pg_advisory\w*|dblink|lo_\w+)\b/i, k);
    for (const fn of v.matchAll(/booking\.([a-z_0-9]+)\s*\(/g)) assert.equal(fn[1], "list_guest_notifications", `${k}: the ONLY booking function called is the reviewed read-only list`);
  }
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-notify-inspect.mjs"), "utf8"); const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /claim_|latch_guest|recover_expired|release_notification|guest_notification_snapshot|presend|complete_guest|suppress_guest|purge_guest|runNotificationStep|notification-worker|resend|executor-adapters|http-transports|real-exchange|api\.resend|hostaway\.com|api\.stripe/i);
  const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["node:child_process", "node:crypto", "node:fs/promises", "node:process", "node:url"]);
  assert.deepEqual([...code.matchAll(/import\(pathToFileURL\(`\$\{dir\}\/([^`]+)`\)\.href\)/g)].map((m) => m[1]).sort(), ["lib/booking-db/pool.js", "scripts/e7-connected/probe-env-preflight.mjs"]);
  assert.match(src, /^if \(import\.meta\.main === true\) \{$/m);
  const r = await R.runHosted({ mode: "execute", env: {}, proc: process, wrapperDir: ROOT }); assert.deepEqual([r.exitCode, r.result.code], [1, "NIN_USAGE"]);
  const s = await R.runHosted({ mode: "send", env: {}, proc: process, wrapperDir: ROOT }); assert.equal(s.result.code, "NIN_USAGE");
});

test("N2 labelled copies: canonical / framedDigest / childEnv / spawnNode shape / dbTargetOk / official CA SHA-256 / fixed TEST constants behave exactly like scripts/e7-hosted-reservation.mjs (imported here for the cross-check only)", async () => {
  const H = await import("../scripts/e7-hosted-reservation.mjs");
  for (const v of [null, 1, "x", [1, { b: 2, a: [3] }], { z: { y: null, x: [true, "é"] }, a: 1 }]) assert.equal(R.canonical(v), H.canonical(v));
  assert.equal(await R.framedDigest(ROOT, C.runnerFiles, "p\n"), await H.framedDigest(ROOT, C.runnerFiles, "p\n"));
  const env = { PATH: "/b", HOME: "/h", E7_DEV_BOOKING_DATABASE_URL: "x", SECRET: "y", TZ: "UTC" };
  assert.deepEqual(R.childEnv(env, "/t"), H.childEnv(env, "/t")); assert.deepEqual(R.CHILD_ENV_ALLOWLIST, H.CHILD_ENV_ALLOWLIST);
  const U = "aws-0-us-east-1.pooler.supabase.com";
  for (const u of [`postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`, `postgres://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`,
    `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:5432/postgres`, `postgresql://postgres.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`,
    `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@${U}:6543/postgres?sslmode=disable`, `postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@evil.example:6543/postgres`, "nope"])
    assert.equal(R.dbTargetOk(u), H.dbTargetOk(u), u.replace(/:pw@/, ":***@"));
  assert.equal(R.OFFICIAL_CA_SHA256, H.OFFICIAL_CA_SHA256);
  assert.deepEqual([C.listingId, C.dbEnvironment, C.dbProjectRef, C.nodeVersion, [...C.protectedReservationIds]],
    [H.CONSTANTS.listingId, H.CONSTANTS.dbEnvironment, H.CONSTANTS.dbProjectRef, H.CONSTANTS.nodeVersion, [...H.CONSTANTS.protectedReservationIds]]);
  const o = await R.spawnNode(["-e", "process.stdout.write('ok')"], { cwd: ROOT, env: { PATH: process.env.PATH } });
  assert.deepEqual([o.status, o.stdout, o.truncated, o.spawnFailed], [0, "ok", false, false]);
});

test("N3 independent closure manifest at the immutable tooling d322d219: the runtime roots (pool.js, probe-env-preflight.mjs) import nothing relative; closure = roots + package.json + package-lock.json; digest recomputed; lockfile pins pg 8.18.0", async () => {
  assert.equal(execFileSync("git", ["-C", TOOLING, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), C.toolingCommit, "E7_TOOLING_DIR must be the pinned d322d219 checkout");
  const scan = (rel, seen = new Set()) => {
    if (seen.has(rel)) return seen; seen.add(rel);
    const s = readFileSync(join(TOOLING, rel), "utf8");
    for (const m of s.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
      const t = (m[1] ?? m[2]); scan(join(dirname(rel), t).replace(/\\/g, "/"), seen);
    }
    return seen;
  };
  const files = new Set([...scan("lib/booking-db/pool.js"), ...scan("scripts/e7-connected/probe-env-preflight.mjs"), "package.json", "package-lock.json"]);
  assert.deepEqual([...files].sort(), [...C.closure].sort());
  assert.equal(await R.framedDigest(TOOLING, C.closure, R.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  const lock = JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/pg"].version, C.pgVersion);
});

test("N4 plan hash: deterministic, binds every input, the tooling / closure / source / catalog pins / protected ids, and states executeEnabled / sendEnabled false", () => {
  const base = { approvalRef: "label-c47", intentId: IID, opId: OID, expectedVersion: VER, sourceDigest: "a".repeat(64) };
  const h0 = R.buildPlan(C, base).planHash;
  assert.equal(R.buildPlan(C, { ...base }).planHash, h0); assert.match(h0, /^[0-9a-f]{64}$/);
  for (const [k, v] of [["approvalRef", "label-x"], ["intentId", "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f608"], ["opId", "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0e"], ["expectedVersion", 10], ["sourceDigest", "b".repeat(64)]])
    assert.notEqual(R.buildPlan(C, { ...base, [k]: v }).planHash, h0, k);
  for (const over of [{ closureDigest: "c".repeat(64) }, { toolingCommit: "d".repeat(40) }, { listingId: 1 }, { protectedReservationIds: [] }, { catalogPins: {} }])
    assert.notEqual(R.buildPlan({ ...C, ...over }, base).planHash, h0, Object.keys(over)[0]);
  const p = R.buildPlan(C, base).plan; assert.deepEqual([p.executeEnabled, p.sendEnabled, p.kind], [false, false, "notify-admission-inspection-read-only"]);
});

test("N5 core happy path (fake, schema 21 / 22 / 23): exact statement sequence ending in ROLLBACK; ELIGIBLE by the 0016 class; allowlisted fields only — extra PII columns in replies never reach the result; receipts reported only at 23", async () => {
  for (const schema of [21, 22, 23]) {
    const { res, log } = await inspect(world({ schema, render: [{ template_version: "gn-v1", intent_version: VER, message_ref: `gn1-${OID}`, content_hash: "1".repeat(64), facts_hash: "2".repeat(64),
      has_recipient_hash: true, locale: null, copy_contract_version: null, recipient: "SENTINEL@example.test" }] }));
    assert.equal(res.code, "INSPECTED", JSON.stringify(res)); assert.equal(res.catalogSchema, schema);
    assert.deepEqual(log, schema === 23 ? [...HAPPY21.slice(0, -1), "receipts", "rollback"] : HAPPY21);
    const a = res.admission;
    assert.deepEqual([a.notifyClass, a.eligibleBy0016Class, a.latchCode, a.refusalDetail], ["ELIGIBLE", true, null, "UNAVAILABLE_TO_RUNTIME_ROLE"]);
    assert.deepEqual(a.operation, { state: "pending", attempts: 0, sourceVersionMatchesIntent: true, dispatched: false, leased: false, completed: false, hasResultRef: false, errorCode: null, template: "booking_confirmed" });
    assert.deepEqual(a.intent, { state: "confirmed", version: VER, listingId: 606998, currency: "USD", hasReservation: true });
    assert.deepEqual(a.render, { templateVersion: "gn-v1", intentVersion: VER, messageRef: `gn1-${OID}`, contentHash: "1".repeat(64), factsHash: "2".repeat(64), hasRecipientHash: true, locale: null, copyContractVersion: null });
    assert.deepEqual(a.receipts, schema === 23 ? { count: 0, anyReplayed: false } : `UNAVAILABLE_AT_SCHEMA_${schema}`);
    assert.doesNotMatch(JSON.stringify(res), PII); assert.ok(Object.isFrozen(res) && Object.isFrozen(res.admission));
  }
  const oos = await inspect(world({ pages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", state: "pending", class: "OUT_OF_V1_SCOPE", code: null }]] }));
  assert.deepEqual([oos.res.code, oos.res.admission.notifyClass, oos.res.admission.eligibleBy0016Class], ["INSPECTED", "OUT_OF_V1_SCOPE", false], "a real-style recipient is shown truthfully as NOT eligible");
  // paging: the op on the 3rd page (full pages before it), the cursor = the last op id of the previous page
  const filler = (n, k) => Array.from({ length: n }, (_, j) => ({ op_id: `00000000-0000-4000-8000-${String(k * 1000 + j).padStart(12, "0")}`, intent_id: IID, template: "booking_confirmed", state: "pending", class: "OTHER", code: null }));
  const paged = await inspect(world({ pages: [filler(100, 1), filler(100, 2), [{ op_id: OID, intent_id: IID, template: "booking_confirmed", state: "pending", class: "LATCHED", code: "RECIPIENT_MISSING" }]] }));
  assert.deepEqual([paged.res.code, paged.res.admission.notifyClass, paged.res.admission.latchCode, paged.log.filter((x) => x === "page").length], ["INSPECTED", "LATCHED", "RECIPIENT_MISSING", 3]);
  const absent = await inspect(world({ pages: [filler(3, 1)] }));
  assert.deepEqual([absent.res.code, absent.res.admission.notifyClass, absent.res.admission.eligibleBy0016Class], ["INSPECTED", "NOT_LISTED", false], "protected / unlisted rows are never claimed eligible");
});

test("N6 core refusals (fake): role / read-only / catalog (unknown, drifted section, read-path drift) / environment / intent / listing / version / protected / op binding / payload shape / reply shape / budgets — each refuses with a code, ROLLBACK attempted, no admission, no leak", async () => {
  const rows1 = (o) => [{ ...world().intent[0], ...o }]; const ops1 = (o) => [{ ...world().op[0], ...o }];
  const drift = { ...pin(21), sections: { ...pin(21).sections, fn: "e".repeat(64) } };
  const cases = [
    [{ role: { ...world().role, ro: "off" } }, "NIN_NOT_READ_ONLY"], [{ role: { ...world().role, iso: "read committed" } }, "NIN_NOT_READ_ONLY"],
    [{ role: { ...world().role, su: true } }, "NIN_ROLE_REFUSED"], [{ role: { ...world().role, app: false } }, "NIN_ROLE_REFUSED"],
    [{ role: { ...world().role, adm: true } }, "NIN_ROLE_REFUSED"], [{ role: { ...world().role, rep: true } }, "NIN_ROLE_REFUSED"], [{ role: { ...world().role, own: true } }, "NIN_ROLE_REFUSED"],
    [{ catalogOverride: drift }, "NIN_CATALOG_UNKNOWN"], [{ catalogOverride: { ...pin(23), readPath: "f".repeat(64) } }, "NIN_CATALOG_UNKNOWN"],
    [{ catalogOverride: { ...pin(22), readPathCount: 5 } }, "NIN_CATALOG_UNKNOWN"], [{ catalogOverride: { ...pin(21), sections: { ...pin(21).sections, extra: "a".repeat(64) } } }, "NIN_REPLY_SHAPE"],
    [{ instance: { n: 1, env: "live" } }, "NIN_NOT_TEST"], [{ instance: { n: 2, env: "test" } }, "NIN_NOT_TEST"],
    [{ intent: [] }, "NIN_INTENT_NOT_FOUND"], [{ intent: rows1({ listing_id: 603566 }) }, "NIN_LISTING_MISMATCH"], [{ intent: rows1({ version: VER + 1 }) }, "NIN_VERSION_MISMATCH"],
    [{ intent: rows1({ protected_reservation: true }) }, "NIN_PROTECTED"], [{ intent: rows1({ id: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f600" }) }, "NIN_REPLY_SHAPE"],
    [{ op: [] }, "NIN_OP_NOT_FOUND"], [{ op: ops1({ intent_id: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f600" }) }, "NIN_OP_INTENT_MISMATCH"],
    [{ op: ops1({ op_type: "hostaway.record_offline_charge" }) }, "NIN_OP_NOT_NOTIFY"], [{ op: ops1({ protected_payload: true }) }, "NIN_PROTECTED"],
    [{ op: ops1({ payload_keys: ["recipient", "template"] }) }, "NIN_OP_PAYLOAD_SHAPE"], [{ op: ops1({ payload_keys: [] }) }, "NIN_OP_PAYLOAD_SHAPE"],
    [{ op: ops1({ error_code: "SENTINEL lower-case text" }) }, "NIN_REPLY_SHAPE"],
    [{ pages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", state: "pending", class: "MAYBE", code: null }]] }, "NIN_REPLY_SHAPE"],
    [{ pages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", state: "pending", class: "LATCHED", code: "sentinel@x" }]] }, "NIN_REPLY_SHAPE"],
    [{ pages: [[{ op_id: OID, intent_id: "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f600", template: "booking_confirmed", state: "pending", class: "ELIGIBLE", code: null }]] }, "NIN_REPLY_SHAPE"],
    [{ pages: [[{ op_id: "not-a-uuid" }]] }, "NIN_REPLY_SHAPE"],
    [{ render: [{ template_version: "gn-v1", intent_version: VER, message_ref: "gn1-other", content_hash: "1".repeat(64), facts_hash: "2".repeat(64), has_recipient_hash: true, locale: null, copy_contract_version: null }] }, "NIN_REPLY_SHAPE"],
    [{ render: [{}, {}] }, "NIN_REPLY_SHAPE"], [{ latch: [{ code: "x y", intent_version_seen: 1 }] }, "NIN_REPLY_SHAPE"]];
  for (const [over, code] of cases) {
    const { res, log } = await inspect(world(over));
    assert.equal(res.code, code, JSON.stringify(over).slice(0, 120)); assert.equal(res.admission, null);
    assert.equal(log.at(-1), "rollback", "ROLLBACK attempted"); assert.ok(log.every((x) => !x.startsWith("UNLISTED")));
    assert.doesNotMatch(JSON.stringify(res), PII);
  }
  const full = (k) => Array.from({ length: 100 }, (_, j) => ({ op_id: `00000000-0000-4000-8000-${String(k * 1000 + j).padStart(12, "0")}`, intent_id: IID, template: "booking_confirmed", state: "pending", class: "OTHER", code: null }));
  const many = await inspect(world({ pages: Array.from({ length: 25 }, (_, k) => full(k + 1)) }));
  assert.deepEqual([many.res.code, many.log.filter((x) => x === "page").length], ["NIN_BUDGET", 20], "page budget");
  const tight = await inspect(world(), { ...C, budgets: { ...C.budgets, statements: 5 } }); assert.equal(tight.res.code, "NIN_BUDGET");
});

test("N7 partial reply / failure / timeout at EVERY stage: sanitized NIN_DB_FAILED / NIN_DB_TIMEOUT with the stage name only (never the database text), ROLLBACK attempted after BEGIN, a failing ROLLBACK turns success into NIN_DB_FAILED", async () => {
  for (const k of ["begin", "bounds", "role", "catalog", "instance", "intent", "op", "page", "render", "latch", "receipts"]) {
    const { res, log } = await inspect(world({ schema: 23, throwAt: k }));
    assert.equal(res.code, "NIN_DB_FAILED", k); assert.equal(res.admission, null); assert.doesNotMatch(JSON.stringify(res), PII);
    assert.equal(res.stage, { page: "class", receipts: "receipts" }[k] ?? k);
    assert.equal(log.at(-1) === "rollback", k !== "begin", `${k}: rollback after BEGIN only`);
  }
  const fast = { ...C, budgets: { ...C.budgets, overallMs: 60 } };
  for (const k of ["catalog", "page", "render"]) {
    const t0 = Date.now(); const { res, log } = await inspect(world({ hangAt: k }), fast);
    assert.equal(res.code, "NIN_DB_TIMEOUT", k); assert.ok(Date.now() - t0 < 2500, "bounded"); assert.equal(log.at(-1), "rollback");
  }
  const rb = await inspect(world({ rollbackFails: true })); assert.deepEqual([rb.res.code, rb.res.stage, rb.res.admission], ["NIN_DB_FAILED", "rollback", null]);
});

// ---- hosted boot -----------------------------------------------------------------------------------------------------------------------
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const SOURCE = await R.framedDigest(ROOT, C.runnerFiles, R.SOURCE_DIGEST_PREFIX);
const inputs = { E7_APPROVAL_REF: "label-c47", E7_INTENT_ID: IID, E7_OP_ID: OID, E7_EXPECTED_VERSION: String(VER) };
const REAL_PLAN = R.buildPlan(C, { approvalRef: "label-c47", intentId: IID, opId: OID, expectedVersion: VER, sourceDigest: SOURCE }).planHash;
const gated = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, ...inputs, E7_EXPECTED_PLAN_HASH: REAL_PLAN, E7_EXPECTED_SOURCE_DIGEST: SOURCE, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest,
  E7_WORKFLOW_SHA: "1".repeat(40), E7_RUN_ID: "123456789-1", GITHUB_REF: "refs/heads/main", PATH: process.env.PATH, ...over });
const okChild = async () => ({ status: 0, signal: null, stdout: "# tests 3\n# pass 3\n# fail 0\n# skipped 0\n", truncated: false, spawnFailed: false });
const DBURL = "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:FAKEPW@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
function fakeDeps(over = {}) {
  const st = { pools: 0, connects: 0, released: 0, ended: 0, cfg: null, inspected: 0 };
  const deps = { spawnChild: okChild, readPgVersion: async () => "8.18.0", readCa: async () => Buffer.from("FAKE-CA"), caSha256: sha(Buffer.from("FAKE-CA")),
    importPool: async () => ({ createBookingPool: (cfg) => { st.pools += 1; st.cfg = { ...cfg, connectionString: cfg.connectionString === DBURL ? "<the secret>" : "?" };
      return { connect: async () => { st.connects += 1; const fc = fakeClient(world()); return { query: fc.query, release: () => { st.released += 1; } }; }, end: async () => { st.ended += 1; } }; } }),
    ...over };
  return { deps, st };
}

test("N8 hosted preflight: no environment / secret / DB; spawns ONLY the two focused test files; synthetic or REAL plan hash; any unexpected E7_* (recipient, sender, body, provider key) or a DB secret outside inspect is refused BEFORE anything else", async () => {
  let spawned = null;
  const p = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, PATH: process.env.PATH }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async (a, o) => { spawned = { a, o }; return okChild(); } } });
  assert.deepEqual([p.exitCode, p.result.code, p.result.planKind, p.result.sourceDigest, p.result.closureDigest], [0, "PREFLIGHT_OK_SYNTHETIC_ONLY", "SYNTHETIC", SOURCE, C.closureDigest]);
  assert.deepEqual(spawned.a, ["--test", "--test-reporter=tap", "test/e7-hosted-notify-inspect.test.mjs", "test/e7-hosted-notify-inspect-workflow.test.mjs"]);
  assert.deepEqual(Object.keys(spawned.o.env).sort(), ["E7_TOOLING_DIR", "PATH"], "the child gets no input / secret");
  const real = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, ...inputs }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.deepEqual([real.result.code, real.result.planHash], ["PREFLIGHT_OK_REAL_PLAN", REAL_PLAN]);
  for (const k of ["E7_RECIPIENT", "E7_TO", "E7_SENDER", "E7_SUBJECT", "E7_BODY", "E7_LOCALE", "E7_RESEND_TEST_KEY", "E7_HOSTAWAY_TOKEN", "E7_STRIPE_TEST_KEY", "E7_EXPECTED_RUNNER_DIGEST"]) {
    const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, [k]: "x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: () => assert.fail("never") } });
    assert.equal(r.result.code, "NIN_INPUT_UNEXPECTED", k);
  }
  for (const mode of ["preflight", "verify"]) {
    const r = await R.runHosted({ mode, env: gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: fakeDeps().deps });
    assert.equal(r.result.code, "NIN_SECRET_SCOPE_VIOLATION", mode); assert.doesNotMatch(JSON.stringify(r), /FAKEPW/);
  }
  for (const [over, code] of [[{ E7_OP_ID: "" }, "NIN_INPUT_INCOMPLETE"], [{ E7_INTENT_ID: "not-a-uuid" }, "NIN_INPUT_INVALID"], [{ E7_OP_ID: IID }, "NIN_INPUT_INVALID"],
    [{ E7_EXPECTED_VERSION: "0" }, "NIN_INPUT_INVALID"], [{ E7_APPROVAL_REF: "bad label!" }, "NIN_INPUT_INVALID"], [{ E7_INTENT_ID: C.synthetic.intentId }, "NIN_INPUT_INVALID"]]) {
    const r = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, ...inputs, ...over }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
    assert.equal(r.result.code, code, JSON.stringify(over));
  }
  const bad = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: async () => ({ ...(await okChild()), stdout: "# tests 3\n# pass 2\n# fail 1\n" }) } });
  assert.equal(bad.result.code, "NIN_TESTS_FAILED");
  const node = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: { ...PROC, versions: { node: "22.21.0" } }, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(node.result.code, "NIN_ENV_REFUSED");
  const nodeOpt = await R.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING, NODE_OPTIONS: "--x" }, proc: PROC, wrapperDir: ROOT, deps: { spawnChild: okChild } });
  assert.equal(nodeOpt.result.code, "NIN_ENV_REFUSED");
});

test("N9 hosted verify / inspect gates: main only, run id, every expected digest exact (plan / source / closure), tooling layout + closure; inspect: pinned pg, DB target, pinned CA, ONE pool (max 1) + ONE client, secret removed from env, client released, pool ended; core failure → exit 1", async () => {
  const v = await R.runHosted({ mode: "verify", env: gated(), proc: PROC, wrapperDir: ROOT, deps: fakeDeps().deps }); assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"]);
  for (const [over, code] of [[{ GITHUB_REF: "refs/heads/e7-test" }, "NIN_REF_NOT_MAIN"], [{ E7_RUN_ID: "x" }, "NIN_INPUT_INVALID"], [{ E7_EXPECTED_PLAN_HASH: "" }, "NIN_INPUT_INCOMPLETE"],
    [{ E7_EXPECTED_PLAN_HASH: "f".repeat(64) }, "NIN_PLAN_HASH_MISMATCH"], [{ E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, "NIN_SOURCE_MISMATCH"],
    [{ E7_EXPECTED_CLOSURE_DIGEST: "f".repeat(64) }, "NIN_CLOSURE_MISMATCH"], [{ E7_EXPECTED_VERSION: "10" }, "NIN_PLAN_HASH_MISMATCH"], [{ E7_TOOLING_DIR: ROOT }, "NIN_LAYOUT_INVALID"],
    [{ E7_TOOLING_DIR: "/nonexistent" }, "NIN_LAYOUT_INVALID"], [{ E7_APPROVAL_REF: "", E7_INTENT_ID: "", E7_OP_ID: "", E7_EXPECTED_VERSION: "" }, "NIN_INPUT_INCOMPLETE"]]) {
    for (const mode of ["verify", "inspect"]) {
      const { deps, st } = fakeDeps();
      const r = await R.runHosted({ mode, env: gated({ ...(mode === "inspect" ? { E7_DEV_BOOKING_DATABASE_URL: DBURL } : {}), ...over }), proc: PROC, wrapperDir: ROOT, deps });
      assert.equal(r.result.code, code, `${mode} ${JSON.stringify(over)}`); assert.equal(st.pools, 0, "no pool before every gate passed"); assert.doesNotMatch(JSON.stringify(r), /FAKEPW/);
    }
  }
  const drift = mkdtempSync(join(tmpdir(), "e7-c47-drift-")); try {
    for (const f of C.closure) { execFileSync("mkdir", ["-p", join(drift, dirname(f))]); writeFileSync(join(drift, f), readFileSync(join(TOOLING, f))); }
    writeFileSync(join(drift, "lib/booking-db/pool.js"), readFileSync(join(TOOLING, "lib/booking-db/pool.js"), "utf8") + "\n// drift\n");
    const r = await R.runHosted({ mode: "verify", env: gated({ E7_TOOLING_DIR: drift }), proc: PROC, wrapperDir: ROOT, deps: fakeDeps().deps }); assert.equal(r.result.code, "NIN_CLOSURE_MISMATCH");
  } finally { rmSync(drift, { recursive: true, force: true }); }
  for (const [over, code] of [[{ readPgVersion: async () => "8.17.0" }, "NIN_DEPENDENCY_MISMATCH"], [{ readCa: async () => Buffer.from("OTHER") }, "NIN_CA_INVALID"],
    [{ importPool: async () => { throw new Error("x"); } }, "NIN_IMPORT_FAILED"]]) {
    const { deps, st } = fakeDeps(over); const env = gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL });
    const r = await R.runHosted({ mode: "inspect", env, proc: PROC, wrapperDir: ROOT, deps });
    assert.deepEqual([r.result.code, st.pools, Object.hasOwn(env, "E7_DEV_BOOKING_DATABASE_URL")], [code, 0, false]);
  }
  for (const url of [DBURL.replace(":6543", ":5432"), DBURL.replace("mv_booking_app_dev", "postgres"), "postgresql://x@localhost:5432/postgres"]) {
    const { deps, st } = fakeDeps(); const r = await R.runHosted({ mode: "inspect", env: gated({ E7_DEV_BOOKING_DATABASE_URL: url }), proc: PROC, wrapperDir: ROOT, deps });
    assert.deepEqual([r.result.code, st.pools], ["NIN_DB_TARGET_INVALID", 0]);
  }
  const miss = await R.runHosted({ mode: "inspect", env: gated(), proc: PROC, wrapperDir: ROOT, deps: fakeDeps().deps }); assert.equal(miss.result.code, "NIN_CREDENTIALS_MISSING");
  const { deps, st } = fakeDeps(); const env = gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL });
  const ok = await R.runHosted({ mode: "inspect", env, proc: PROC, wrapperDir: ROOT, deps });
  assert.deepEqual([ok.exitCode, ok.result.code, ok.result.core.code, ok.result.core.admission.notifyClass, ok.result.runId], [0, "INSPECT_DONE", "INSPECTED", "ELIGIBLE", "123456789-1"]);
  assert.deepEqual([st.pools, st.connects, st.released, st.ended, st.cfg.max, st.cfg.statementTimeoutMs, st.cfg.connectionString, st.cfg.caPem], [1, 1, 1, 1, 1, 5000, "<the secret>", "FAKE-CA"]);
  assert.equal(Object.hasOwn(env, "E7_DEV_BOOKING_DATABASE_URL"), false, "the secret is removed from the environment before any connection");
  assert.doesNotMatch(JSON.stringify(ok) + R.summaryMarkdown(ok.result), PII);
  const fail = await R.runHosted({ mode: "inspect", env: gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT,
    deps: fakeDeps({ inspect: async () => Object.freeze({ code: "NIN_VERSION_MISMATCH", stage: "intent", statements: 6, catalogSchema: 21, catalogSections: null, admission: null }) }).deps });
  assert.deepEqual([fail.exitCode, fail.result.code, fail.result.core.code], [1, "INSPECT_DONE", "NIN_VERSION_MISMATCH"]);
  const noConn = await R.runHosted({ mode: "inspect", env: gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT,
    deps: fakeDeps({ importPool: async () => ({ createBookingPool: () => ({ connect: async () => { throw new Error("SENTINEL FAKEPW"); }, end: async () => {} }) }) }).deps });
  assert.deepEqual([noConn.exitCode, noConn.result.core.code, noConn.result.core.stage], [1, "NIN_DB_FAILED", "connect"]); assert.doesNotMatch(JSON.stringify(noConn), PII);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN REAL DISPOSABLE POSTGRESQL (E7_HNI_DB_TESTS=1): the tooling's accepted migrator / harness / fixtures at d322d219; the RUNTIME APP ROLE.
if (DB_TESTS) {
  const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
  const pg = createRequire(join(TOOLING, "package.json"))("pg");
  const [{ startPostgres }, { migrateUp }, F] = await Promise.all([tool("test/db/harness.mjs"), tool("db/lib/migrate.js"), tool("test/db/fixtures.mjs")]);
  async function dbAt(to) {
    const base = await startPostgres(); const owner = new pg.Client({ connectionString: base.adminUrl }); await owner.connect();
    await migrateUp(owner, { env: "test", to });
    for (const [r, g] of [["test_app", "mv_booking_app"], ["test_report", "mv_booking_report"], ["test_admin", "mv_booking_admin"]]) await owner.query(`CREATE ROLE ${r} LOGIN IN ROLE ${g}`);
    const app = new pg.Pool({ connectionString: base.appUrl(), max: 4 }); const ownerPool = new pg.Pool({ connectionString: base.adminUrl, max: 2 });
    return { base, owner, app, ownerPool, async close() { await app.end().catch(() => {}); await ownerPool.end().catch(() => {}); await owner.end().catch(() => {}); base.stop(); } };
  }
  const fingerprint = async (owner) => (await owner.query(`SELECT jsonb_object_agg(t.relname, x.v) AS f FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace,
      LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(to_jsonb(x)::text, E''\\n'' ORDER BY to_jsonb(x)::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x
      WHERE s.nspname = 'booking' AND t.relkind = 'r'`)).rows[0].f;
  const appClient = async (d, url = d.base.appUrl()) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
  const run = async (d, intentId, opId, expectedVersion, url) => {
    const c = await appClient(d, url); try { return await R.inspectNotification({ client: c, plan: R.buildPlan(C, { approvalRef: "label-db", intentId, opId, expectedVersion, sourceDigest: "a".repeat(64) }).plan, c: C }); } finally { await c.end(); }
  };
  const notifyOf = async (d, id) => (await d.owner.query("SELECT id::text FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id])).rows[0].id;
  const verOf = async (d, id) => (await d.owner.query("SELECT version FROM booking.intents WHERE id = $1", [id])).rows[0].version;

  test("D1 catalog pins == the tooling migrations read as the RUNTIME APP ROLE (and as the owner) at 21 / 22 / 23; the read path is STABLE / IMMUTABLE, calls only itself, and has no write / lock / sequence / dynamic SQL token", async () => {
    for (const to of [21, 22, 23]) {
      const d = await dbAt(to); try {
        const a = await appClient(d); try {
          const id = (await a.query(Q.catalog, [[...R.READ_PATH_FUNCTIONS]])).rows[0].id;
          assert.deepEqual(id.sections, pin(to).sections, `sections @${to}`); assert.deepEqual([id.readPath, id.readPathCount], [pin(to).readPath, 6]);
          assert.deepEqual((await d.owner.query(Q.catalog, [[...R.READ_PATH_FUNCTIONS]])).rows[0].id, id, "role-independent identity");
          const fns = (await a.query("SELECT p.proname, p.provolatile, pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.pronamespace = 'booking'::regnamespace AND p.proname = ANY ($1::text[]) ORDER BY 1", [[...R.READ_PATH_FUNCTIONS]])).rows;
          assert.deepEqual(fns.map((f) => f.proname), [...R.READ_PATH_FUNCTIONS].sort());
          for (const f of fns) {
            assert.ok(["s", "i"].includes(f.provolatile), `${f.proname} is STABLE / IMMUTABLE`);
            const body = f.def.slice(f.def.indexOf("AS $"));
            assert.doesNotMatch(body, /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|EXECUTE|LOCK|nextval|setval|set_config|pg_advisory\w*|dblink|pg_sleep)\b/i, f.proname);
            for (const m of body.matchAll(/booking\.([a-z_0-9]+)\s*\(/g)) assert.ok(R.READ_PATH_FUNCTIONS.includes(m[1]), `${f.proname} → booking.${m[1]} is in the read path`);
          }
          assert.equal((await a.query("SELECT has_function_privilege('booking.list_guest_notifications(integer[],uuid,integer)', 'EXECUTE') AS x")).rows[0].x, true);
          assert.equal((await a.query("SELECT has_function_privilege('booking.guest_notification_refusal(uuid)', 'EXECUTE') AS x")).rows[0].x, false, "refusal detail is owner-only (reported as unavailable)");
        } finally { await a.end(); }
      } finally { await d.close(); }
    }
  });

  for (const to of [21, 23]) {
    test(`D2 schema ${to}: accepted fixtures on 606998 — the real-style (non-.invalid) queued notify is OUT_OF_V1_SCOPE (not eligible), a .invalid one is ELIGIBLE; wrong intent / op / version / listing / protected / environment / catalog / role refused; READ ONLY enforced; lock wait → sanitized failure; ZERO mutation of every booking table; no PII in any result`, async () => {
      const d = await dbAt(to); try {
        const a = await F.confirmed(d.app, { listingId: 606998, from: "2028-03-01", to: "2028-03-04" });
        const b = await F.confirmed(d.app, { listingId: 606998, from: "2028-04-01", to: "2028-04-04" });
        await F.ownerManagedHistory(d.ownerPool, "UPDATE booking.intent_guests SET email = 'zq.fixture.guest@mv-test.invalid' WHERE intent_id = $1", [b.id]);   // TEST SETUP: an in-scope synthetic recipient
        const other = await F.confirmed(d.app, { listingId: 603566, from: "2028-05-01", to: "2028-05-04" });
        const prot = await F.confirmed(d.app, { listingId: 606998, from: "2028-06-01", to: "2028-06-04" });
        await F.ownerManagedHistory(d.ownerPool, "UPDATE booking.intents SET hostaway_reservation_id = '70636076' WHERE id = $1", [prot.id]);                    // TEST SETUP: a protected id
        // TEST SETUP: the accepted fixture books MXN (its recording proof is MXN-only); the 0016 class also refuses non-USD, so set USD (owner-managed) so
        // that the ONLY remaining difference between `a` (fixture `.example.test` guest = the real-style recipient shape) and `b` (`.invalid`) is the recipient
        for (const x of [a, b, prot]) await F.ownerManagedHistory(d.ownerPool, "UPDATE booking.intents SET currency = 'USD', price_snapshot = jsonb_set(price_snapshot, '{currency}', '\"USD\"') WHERE id = $1", [x.id]);
        const [opA, opB, opO, opP] = await Promise.all([a, b, other, prot].map((x) => notifyOf(d, x.id)));
        const [vA, vB, vO, vP] = await Promise.all([a, b, other, prot].map((x) => verOf(d, x.id)));
        const f0 = await fingerprint(d.owner);
        const ra = await run(d, a.id, opA, vA);
        assert.equal(ra.code, "INSPECTED", JSON.stringify(ra)); assert.equal(ra.catalogSchema, to);
        assert.deepEqual([ra.admission.notifyClass, ra.admission.eligibleBy0016Class, ra.admission.operation.state, ra.admission.operation.attempts, ra.admission.render, ra.admission.latch],
          ["OUT_OF_V1_SCOPE", false, "pending", 0, null, null], "the out-of-scope recipient is shown truthfully as not eligible");
        assert.deepEqual(ra.admission.receipts, to === 23 ? { count: 0, anyReplayed: false } : "UNAVAILABLE_AT_SCHEMA_21");
        const rb = await run(d, b.id, opB, vB);
        assert.deepEqual([rb.code, rb.admission.notifyClass, rb.admission.eligibleBy0016Class], ["INSPECTED", "ELIGIBLE", true]);
        for (const x of [ra, rb]) assert.doesNotMatch(JSON.stringify(x), /Zanabria|Quintessa|zq\.fixture|@|\+52/);
        const refused = [
          [await run(d, a.id, opA, vA + 1), "NIN_VERSION_MISMATCH"], [await run(d, b.id, opA, vB), "NIN_OP_INTENT_MISMATCH"],
          [await run(d, "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607", opA, vA), "NIN_INTENT_NOT_FOUND"], [await run(d, a.id, "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", vA), "NIN_OP_NOT_FOUND"],
          [await run(d, a.id, a.recordingOpId, vA), "NIN_OP_NOT_NOTIFY"], [await run(d, other.id, opO, vO), "NIN_LISTING_MISMATCH"], [await run(d, prot.id, opP, vP), "NIN_PROTECTED"],
          [await run(d, a.id, opA, vA, d.base.adminUrl), "NIN_ROLE_REFUSED"], [await run(d, a.id, opA, vA, d.base.reportUrl()), "NIN_ROLE_REFUSED"],
          [await run(d, a.id, opA, vA, d.base.adminUrl2()), "NIN_ROLE_REFUSED"]];
        for (const [res, code] of refused) { assert.equal(res.code, code, JSON.stringify(res).slice(0, 200)); assert.equal(res.admission, null); }
        await d.owner.query("UPDATE booking.instance SET environment = 'live'"); assert.equal((await run(d, a.id, opA, vA)).code, "NIN_NOT_TEST"); await d.owner.query("UPDATE booking.instance SET environment = 'test'");
        await d.owner.query("CREATE FUNCTION booking._e7_drift() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$");
        assert.equal((await run(d, a.id, opA, vA)).code, "NIN_CATALOG_UNKNOWN", "a drifted / future catalog is never adopted"); await d.owner.query("DROP FUNCTION booking._e7_drift()");
        // READ ONLY: a hostile write injected INSIDE the inspection transaction is rejected by PostgreSQL (25006), never applied
        { const c = await appClient(d); let ro = null;
          const spy = { query: async (t, p) => { const r = await c.query(t, p); if (t === Q.role) { try { await c.query("UPDATE booking.intents SET version = version WHERE id = $1", [a.id]); } catch (e) { ro = e.code; } } return r; } };
          const res = await R.inspectNotification({ client: spy, plan: R.buildPlan(C, { approvalRef: "l", intentId: a.id, opId: opA, expectedVersion: vA, sourceDigest: "a".repeat(64) }).plan, c: C });
          assert.equal(ro, "25006", "read-only transaction"); assert.deepEqual([res.code, res.stage], ["NIN_DB_FAILED", "catalog"]); await c.end(); }
        // a held lock: the bounded lock_timeout turns the wait into a sanitized failure
        { const h = new pg.Client({ connectionString: d.base.adminUrl }); await h.connect(); await h.query("BEGIN"); await h.query("LOCK TABLE booking.notification_renders IN ACCESS EXCLUSIVE MODE");
          const t0 = Date.now(); const res = await run(d, b.id, opB, vB); await h.query("ROLLBACK"); await h.end();
          // the identity read opens the locked relation too (pg_get_*def): still a bounded, sanitized stop
          assert.equal(res.code, "NIN_DB_FAILED"); assert.ok(["catalog", "class", "render"].includes(res.stage), res.stage); assert.ok(Date.now() - t0 < 6000, "bounded wait"); }
        assert.deepEqual(await fingerprint(d.owner), f0, "ZERO mutation of every booking table (no lease / claim / render / latch / receipt / inbox / intent change)");
        assert.equal((await d.owner.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, 0, "no advisory lock taken");
      } finally { await d.close(); }
    });
  }
}
