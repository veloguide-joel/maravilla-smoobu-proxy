// test/e7-hosted-status.test.mjs — C119 S3: the SHIPPED-CLOSED read-only TEST status / reconciliation runner (scripts/e7-hosted-status.mjs).
// Always-on (FAKE): the CLOSED proof, labelled copies, closure, query hygiene, classifiers / thresholds, core shapes / errors / privacy, hosted gates.
// OPT-IN (E7_HST_DB_TESTS=1; PG_BIN; E7_TOOLING_DIR = the pinned 66133a22 checkout with its pinned pg; E7_SCHEMA27_DIR = a checkout of e7-test a314681b
// for the merged 0027 bytes, sha-checked): the REAL core on DISPOSABLE PostgreSQL at schema 28 (C119 S4; was 27) with synthetic fixtures and a synthetic clock (asOf seam).
// Nothing here touches a shared database, a provider or the network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports, createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, mkdtempSync, writeFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const GUARD = { https: 0, http: 0, fetch: 0 };
https.request = () => { GUARD.https += 1; throw new Error("network refused"); };
http.request = () => { GUARD.http += 1; throw new Error("network refused"); };
globalThis.fetch = async () => { GUARD.fetch += 1; throw new Error("network refused"); };
syncBuiltinESMExports();
after(() => { assert.deepEqual(GUARD, { https: 0, http: 0, fetch: 0 }, "no network primitive was touched"); });

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const TOOLING = realpathSync(process.env.E7_TOOLING_DIR || join(ROOT, "..", "tooling"));
const S = await import("../scripts/e7-hosted-status.mjs");
const C = S.CONSTANTS; const Q = S.STATUS_QUERIES;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const OPEN = Object.freeze({ ...C, readEnabled: true });                 // the TEST-LOCAL seam only; the shipped constant stays false
const PROC = { versions: { node: "22.22.0" }, platform: "linux", execArgv: [], getuid: () => 1000 };
const IID = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f607"; const OID = "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d";
const PII = /@|SENTINEL|MV-[A-Z0-9]{5,}|\bpi_[A-Za-z0-9]|\bre_[A-Za-z0-9]|Bearer|FAKEPW|3f1c2b4a|7a8b9c0d/;
const DBURL = "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:FAKEPW@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const never = (n) => async () => { throw new Error(`must not be called: ${n}`); };

test("T1 SHIPPED CLOSED: readEnabled false; verify AND status refuse STS_READ_CLOSED from KEY NAMES only (zero env value reads, imports, DB, CA) even with the secret present; no schedule / arm / activation wiring", async () => {
  assert.equal(C.readEnabled, false); assert.ok(Object.isFrozen(C) && Object.isFrozen(C.thresholds) && Object.isFrozen(C.scope));
  for (const mode of ["verify", "status"]) {
    const reads = []; const base = { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: "a".repeat(64), E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, GITHUB_REF: "refs/heads/main" };
    const env = new Proxy(base, { get(t, k) { reads.push(String(k)); return t[k]; } });
    const r = await S.runHosted({ mode, env, proc: PROC, wrapperDir: ROOT, deps: { importPool: never("pool"), runCore: never("core"), readPgVersion: never("pg"), readCa: never("ca") } });
    assert.deepEqual([r.exitCode, r.result.code, r.result.status, r.result.closureDigest], [1, "STS_READ_CLOSED", null, null], mode);
    assert.deepEqual(reads, [], `${mode}: not one env value was read`);
  }
  const src = readFileSync(join(ROOT, "scripts/e7-hosted-status.mjs"), "utf8"); const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[\s\S]*?\*\//g, "");
  const iClosed = code.indexOf('refuse("STS_READ_CLOSED")'); assert.ok(iClosed > 0);
  for (const later of ["importPool(tooling)", "readCa(", "readPgVersion(", "framedDigest(tooling", "env.E7_DEV_BOOKING_DATABASE_URL", "env.E7_EXPECTED_SOURCE_DIGEST"]) assert.ok(code.indexOf(later) > iClosed, `${later} only after the CLOSED gate`);
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort(), ["node:crypto", "node:fs/promises", "node:process", "node:url"]);
  assert.deepEqual([...code.matchAll(/pathToFileURL\(`\$\{dir\}\/([^`]+)`\)/g)].map((m) => m[1]), ["lib/booking-db/pool.js"], "the ONLY tooling import");
  assert.doesNotMatch(code, /api\.stripe\.com|api\.hostaway\.com|api\.resend\.com|E7_RESEND|E7_STRIPE|E7_HOSTAWAY|E7_DISPATCH_TOKEN|E7_TEST_ARM|E7_TEST_AUTO_ARMED|github\.token/, "no provider endpoint / credential / token / arm");
  assert.match(src, /^if \(import\.meta\.main === true\) \{$/m);
});

test("T2 labelled copies == the merged C50 booking-confirmation runner (catalog probe SQL, owner-ACL canonicaliser, both read paths, the schema-28 pin (C119 S4), DB target rule, CA pin, framedDigest output); closure = pool.js (imports only pg) + package files at 66133a22; pg 8.18.0", async () => {
  const N = await import("../scripts/e7-hosted-booking-confirmation.mjs");
  assert.equal(S.CATALOG_SQL, N.CATALOG_SQL); assert.equal(S.OWNER_ACL_CANON, N.OWNER_ACL_CANON);
  assert.deepEqual([...S.READ_PATH_FUNCTIONS], [...N.READ_PATH_FUNCTIONS]); assert.deepEqual([...S.INSPECT_READ_PATH_FUNCTIONS], [...N.INSPECT_READ_PATH_FUNCTIONS]);
  assert.deepEqual(C.catalogPin28, N.CONSTANTS.catalogPin28);
  const U = "aws-0-us-east-1.pooler.supabase.com";
  for (const u of [DBURL, DBURL.replace(":6543", ":5432"), `postgresql://postgres.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`, `postgresql://mv_booking_admin_dev.mxotevtiscernhqilyiu:pw@${U}:6543/postgres`, "nope"])
    assert.equal(S.dbTargetOk(u), N.dbTargetOk(u), u.slice(0, 40));
  assert.equal(S.dbTargetOk(DBURL), true, "ONLY the runtime app user on the DEV pooler"); assert.equal(S.OFFICIAL_CA_SHA256, N.OFFICIAL_CA_SHA256);
  assert.equal(await S.framedDigest(ROOT, C.runnerFiles, "p\n"), await N.framedDigest(ROOT, C.runnerFiles, "p\n"));
  assert.equal(execGit(TOOLING), C.toolingCommit, "E7_TOOLING_DIR must be the pinned 66133a22 checkout");
  const pool = readFileSync(join(TOOLING, "lib/booking-db/pool.js"), "utf8");
  assert.deepEqual([...pool.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]), ["pg"], "pool.js imports only pg");
  assert.equal(await S.framedDigest(TOOLING, C.closure, S.CLOSURE_DIGEST_PREFIX), C.closureDigest);
  assert.equal(JSON.parse(readFileSync(join(TOOLING, "package-lock.json"), "utf8")).packages["node_modules/pg"].version, C.pgVersion);
});
function execGit(dir) { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }

test("T3 query hygiene: BEGIN REPEATABLE READ READ ONLY … ROLLBACK; every other statement is ONE SELECT with fixed text and positional parameters only; no SQL write keyword; the ONLY booking functions are the reviewed list_guest_notifications page and the 0027 external_cancellation_public projection; no input selects an identifier; every metric names its source", () => {
  for (const [k, v] of Object.entries(Q)) {
    if (k === "begin") assert.equal(v, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); else if (k === "rollback") assert.equal(v, "ROLLBACK");
    else { assert.match(v, /^SELECT /, k); assert.doesNotMatch(v, /;\s*\S/, `${k}: one statement`); }
    assert.doesNotMatch(v.replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|LOCK|NOTIFY|SET\s+ROLE)\b/i, k);
    for (const fn of v.matchAll(/booking\.([a-z_0-9]+)\s*\(/g)) assert.ok(["list_guest_notifications", "external_cancellation_public"].includes(fn[1]), `${k}: ${fn[1]}`);
  }
  assert.doesNotMatch(JSON.stringify(Q), /externally_cancelled\s*\(|external_cancellations\b|external_refund_attestations\b|payment_refunds\b|intent_guests\b/, "no admin / report-only or guest-contact read");
  assert.deepEqual([...S.ALLOWED_E7_KEYS].sort(), ["E7_CA_FILE", "E7_DEV_BOOKING_DATABASE_URL", "E7_EXPECTED_CLOSURE_DIGEST", "E7_EXPECTED_SOURCE_DIGEST", "E7_RUN_ID", "E7_TOOLING_DIR", "E7_WORKFLOW_SHA"], "no identifier / SQL / scope input");
  for (const k of ["kickoff", "pipeline", "operations", "cases", "work", "notifications", "refunds"]) assert.match(S.METRIC_SOURCES[k], /^booking\./, k);
  assert.ok(S.UNOBSERVED.length >= 5 && S.UNOBSERVED.every((u) => /^[A-Z_]+: /.test(u)), "every inaccessible fact is listed as UNOBSERVED");
  assert.deepEqual(C.scope.excludedIntentIds, (JSON.parse(JSON.stringify(C.scope.excludedIntentIds))), "exclusions are a fixed reviewed list");
});

test("T4 classifier truth tables (documented TEST-only technical thresholds): recent waits → WAIT, stalled / unknown → ACTION, a pending manual refund or a cancellation-latched confirmation → INFO (never pages), nothing → OK", () => {
  const T = C.thresholds;
  assert.deepEqual(T, { kickoffRequestedStaleMin: 90, kickoffClaimedStaleMin: 15, kickoffAcceptedNoProgressMin: 30, pipelineStalledMin: 30, authExpiryHorizonMin: 2880, opPendingStaleMin: 60,
    workDueOverdueMin: 30, notifyEligibleStaleMin: 90, notifyWaitingStaleMin: 30, notifyInFlightStaleMin: 30 });
  const k0 = { total: 0, requested: 0, requested_stale: 0, claimed: 0, claimed_stale: 0, accepted: 0, accepted_no_progress: 0, dispatch_unknown: 0, refused: 0, refused_still_authorized: 0, orphan: 0, oldest_requested_min: null };
  assert.equal(S.classifyKickoff(k0), "OK");
  for (const [o, want] of [[{ requested: 1 }, "WAIT"], [{ claimed: 1 }, "WAIT"], [{ requested: 1, requested_stale: 1 }, "ACTION"], [{ claimed: 1, claimed_stale: 1 }, "ACTION"], [{ dispatch_unknown: 1 }, "ACTION"],
    [{ accepted: 1, accepted_no_progress: 1 }, "ACTION"], [{ refused: 1 }, "INFO"], [{ refused: 1, refused_still_authorized: 1 }, "ACTION"], [{ orphan: 1 }, "ACTION"], [{ accepted: 3 }, "OK"]])
    assert.equal(S.classifyKickoff({ ...k0, ...o }), want, JSON.stringify(o));
  const p0 = { in_pipeline: 0, stalled: 0, unknown_states: 0, compensating: 0, compensating_stalled: 0, authorized_uncaptured: 0, auth_horizon_missing: 0, auth_near_expiry: 0 };
  assert.deepEqual(S.classifyPipeline(p0), { pipeline: "OK", authorization: "OK" });
  for (const [o, want] of [[{ in_pipeline: 1, authorized_uncaptured: 1 }, { pipeline: "WAIT", authorization: "WAIT" }], [{ in_pipeline: 1, stalled: 1 }, { pipeline: "ACTION", authorization: "OK" }],
    [{ unknown_states: 1 }, { pipeline: "ACTION", authorization: "OK" }], [{ compensating: 1 }, { pipeline: "WAIT", authorization: "OK" }], [{ compensating: 1, compensating_stalled: 1 }, { pipeline: "ACTION", authorization: "OK" }],
    [{ authorized_uncaptured: 1, auth_near_expiry: 1 }, { pipeline: "OK", authorization: "ACTION" }], [{ authorized_uncaptured: 1, auth_horizon_missing: 1 }, { pipeline: "OK", authorization: "UNKNOWN" }]])
    assert.deepEqual(S.classifyPipeline({ ...p0, ...o }), want, JSON.stringify(o));
  const o0 = { outcome_unknown: 0, escalated: 0, in_flight_expired: 0, in_flight_live: 0, pending: 0, pending_stale: 0 };
  for (const [o, want] of [[{}, "OK"], [{ in_flight_live: 1 }, "WAIT"], [{ pending: 1 }, "WAIT"], [{ outcome_unknown: 1 }, "ACTION"], [{ escalated: 1 }, "ACTION"], [{ in_flight_expired: 1 }, "ACTION"], [{ pending: 1, pending_stale: 1 }, "ACTION"]])
    assert.equal(S.classifyOperations({ ...o0, ...o }), want, JSON.stringify(o));
  assert.equal(S.classifyCases({ open: 0 }), "OK"); assert.equal(S.classifyCases({ open: 1 }), "ACTION");
  for (const [o, want] of [[{ lease_expired: 0, lease_live: 0, due_overdue: 0 }, "OK"], [{ lease_expired: 0, lease_live: 1, due_overdue: 0 }, "WAIT"], [{ lease_expired: 1, lease_live: 0, due_overdue: 0 }, "ACTION"], [{ lease_expired: 0, lease_live: 0, due_overdue: 1 }, "ACTION"]])
    assert.equal(S.classifyWork(o), want);
  const n = (cls, age = 1, code = null, template = "booking_confirmed") => ({ template, class: cls, code, age_min: age });
  for (const [rows, missing, want] of [[[], 0, "OK"], [[n("SUCCEEDED")], 0, "OK"], [[n("ELIGIBLE", 89)], 0, "WAIT"], [[n("ELIGIBLE", 90)], 0, "ACTION"], [[n("LATCHED", 500, "EXTERNALLY_CANCELLED")], 0, "INFO"],
    [[n("LATCHED", 5, "VERSION_DRIFT")], 0, "ACTION"], [[n("LATCHED", 5, "RENDER_FAILED")], 0, "ACTION"], [[n("WAITING", 29)], 0, "WAIT"], [[n("WAITING", 30)], 0, "ACTION"], [[n("IN_FLIGHT", 1)], 0, "WAIT"],
    [[n("IN_FLIGHT", 31)], 0, "ACTION"], [[n("UNKNOWN")], 0, "ACTION"], [[n("OTHER")], 0, "ACTION"], [[n("OUT_OF_V1_SCOPE")], 0, "ACTION"], [[n("SUCCEEDED")], 1, "ACTION"],
    [[n("UNKNOWN", 1, null, "not_completed_not_charged")], 0, "ACTION"], [[n("ELIGIBLE", 999, null, "not_completed_not_charged")], 0, "OK"], [[n("SUCCEEDED"), n("LATCHED", 9, "EXTERNALLY_CANCELLED")], 0, "INFO"]]) {
    const k = S.classifyNotifications(rows, missing, T); assert.equal(k.status, want, JSON.stringify([rows, missing]));
  }
});

// ---- the core through a FAKE client ------------------------------------------------------------------------------------------------------
const AGG = {
  kickoff: { total: 0, requested: 0, requested_stale: 0, claimed: 0, claimed_stale: 0, accepted: 0, accepted_no_progress: 0, dispatch_unknown: 0, refused: 0, refused_still_authorized: 0, orphan: 0, oldest_requested_min: null },
  pipeline: { total: 1, in_pipeline: 0, stalled: 0, unknown_states: 0, compensating: 0, compensating_stalled: 0, confirmed: 1, pre_payment: 0, closed: 0, authorized_uncaptured: 0, auth_horizon_missing: 0, auth_near_expiry: 0,
    oldest_in_pipeline_min: null, min_auth_remaining_min: null },
  operations: { total: 4, outcome_unknown: 0, escalated: 0, in_flight_expired: 0, in_flight_live: 0, pending: 0, pending_stale: 0 },
  cases: { open: 0, oldest_open_min: null }, work: { lease_expired: 0, lease_live: 0, due_overdue: 0 }, notifyMissing: { n: 0 }
};
function world(over = {}) {
  return { role: { ro: "on", iso: "repeatable read", su: false, app: true, adm: false, rep: false, own: false }, catalog: C.catalogPin28, instance: { n: 1, env: "test" }, clock: { ok: true, synthetic: false },
    scope: { n: 1 }, agg: AGG, notifyPages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "SUCCEEDED", code: null, in_scope: true, age_min: 30 }]],
    refunds: [{ x: { cancelled: true, refundStatus: "pending" } }], throwAt: null, ...over };
}
function fakePool(w, log) {
  let page = 0;
  return { connect: async () => ({ query: async (t, p) => {
    const k = Object.keys(Q).find((x) => Q[x] === t) ?? "UNLISTED"; log.push(k); if (k === "UNLISTED") throw new Error("unlisted");
    if (w.throwAt === k) throw new Error("SENTINEL db FAKEPW");
    switch (k) {
      case "role": return { rows: [w.role] };
      case "catalog": return { rows: [{ id: { sections: w.catalog.sections, readPath: w.catalog.readPath, readPathCount: w.catalog.readPathCount } }] };
      case "instance": return { rows: [w.instance] }; case "clock": return { rows: [w.clock] }; case "scope": return { rows: [w.scope] };
      case "kickoff": case "pipeline": case "operations": case "cases": case "work": case "notifyMissing": return w.raw?.[k] ?? { rows: [{ ...w.agg[k] }] };
      case "notifyPage": return { rows: w.notifyPages[page++] ?? [] };
      case "refunds": return { rows: w.refunds };
      default: return { rows: [] };
    } }, release: () => {} }) };
}
const core = (w, c = OPEN, asOf = null) => { const log = []; return S.runStatusCore({ pool: fakePool(w, log), c, asOf }).then((res) => ({ res, log })); };

test("T5 core (fake): ONE read-only snapshot, ROLLBACK last; the C116-like steady state (a SUCCEEDED confirmation + a pending manual refund) is OK — the refund is INFO and never pages; every metric names source + scope; outputs carry codes / counts only", async () => {
  const { res, log } = await core(world());
  assert.deepEqual([res.overall, res.code, res.clock], ["OK", "STATUS_OK", "database"]);
  assert.equal(log[0], "begin"); assert.equal(log.at(-1), "rollback"); assert.ok(!log.includes("UNLISTED"));
  assert.deepEqual(Object.keys(res.metrics), ["kickoff", "pipeline", "authorization", "operations", "cases", "work", "notifications", "refunds"]);
  for (const [k, m] of Object.entries(res.metrics)) { assert.ok(S.STATUS_CODES.includes(m.status), k); assert.match(m.source, /^booking\./, k); assert.match(m.scope, /listing 606998/, k); }
  assert.deepEqual([res.metrics.refunds.status, res.metrics.refunds.counts.refundPending, res.metrics.notifications.status], ["INFO", 1, "OK"]);
  assert.deepEqual(res.unobserved, [...S.UNOBSERVED]); assert.doesNotMatch(JSON.stringify(res), PII);
  const wait = await core(world({ agg: { ...AGG, kickoff: { ...AGG.kickoff, total: 1, requested: 1, oldest_requested_min: 5 } } }));
  assert.deepEqual([wait.res.overall, wait.res.metrics.kickoff.status], ["WAIT", "WAIT"], "a recent request is a healthy wait");
  const act = await core(world({ agg: { ...AGG, operations: { ...AGG.operations, outcome_unknown: 1 } } })); assert.deepEqual([act.res.overall, act.res.metrics.operations.status], ["ATTENTION", "ACTION"]);
  const unk = await core(world({ agg: { ...AGG, pipeline: { ...AGG.pipeline, authorized_uncaptured: 1, auth_horizon_missing: 1 } } })); assert.equal(unk.res.overall, "UNKNOWN", "UNKNOWN outranks everything");
  const syn = await core(world({ clock: { ok: true, synthetic: true } }), OPEN, "2026-11-20T00:00:00.000Z"); assert.equal(syn.res.clock, "synthetic");
});

test("T6 core (fake): missing / unreadable / malformed data is UNKNOWN — never zero, never healthy: a thrown statement → overall UNKNOWN with NO metrics; a malformed aggregate / page / projection → that metric UNKNOWN; role / catalog / instance / clock / scope bound refusals; the statement budget; a page budget overrun", async () => {
  for (const k of ["begin", "role", "catalog", "instance", "clock", "scope", "kickoff", "pipeline", "operations", "cases", "work", "notifyMissing", "notifyPage", "refunds"]) {
    const { res } = await core(world({ throwAt: k }));
    assert.deepEqual([res.overall, res.code, res.metrics], ["UNKNOWN", "STS_DB_FAILED", {}], k); assert.doesNotMatch(JSON.stringify(res), PII);
  }
  for (const [over, code] of [[{ role: { ...world().role, ro: "off" } }, "STS_NOT_READ_ONLY"], [{ role: { ...world().role, adm: true } }, "STS_ROLE_REFUSED"], [{ role: { ...world().role, rep: true } }, "STS_ROLE_REFUSED"],
    [{ role: { ...world().role, own: true } }, "STS_ROLE_REFUSED"], [{ role: { ...world().role, su: true } }, "STS_ROLE_REFUSED"], [{ role: { ...world().role, app: false } }, "STS_ROLE_REFUSED"],
    [{ catalog: { ...C.catalogPin28, readPathCount: 6 } }, "STS_CATALOG_NOT_28"], [{ catalog: { ...C.catalogPin28, sections: { ...C.catalogPin28.sections, fn: "0".repeat(64) } } }, "STS_CATALOG_NOT_28"],
    [{ instance: { n: 1, env: "live" } }, "STS_NOT_TEST"], [{ instance: { n: 2, env: "test" } }, "STS_NOT_TEST"], [{ clock: { ok: true, synthetic: true } }, "STS_REPLY_SHAPE"], [{ scope: { n: 501 } }, "STS_SCOPE_TOO_LARGE"],
    [{ scope: { n: -1 } }, "STS_REPLY_SHAPE"]]) {
    const { res } = await core(world(over)); assert.deepEqual([res.overall, res.code, res.metrics], ["UNKNOWN", code, {}], code);
  }
  for (const [k, raw] of [["kickoff", { rows: [] }], ["kickoff", { rows: [{ ...AGG.kickoff, requested: "1" }] }], ["pipeline", { rows: [{ ...AGG.pipeline, extra: 1 }] }], ["operations", { rows: [{ ...AGG.operations, pending: -1 }] }],
    ["cases", { rows: [{ open: 0 }] }], ["work", { rows: [AGG.work, AGG.work] }], ["notifyMissing", { rows: [{ n: null }] }]]) {
    const { res } = await core(world({ raw: { [k]: raw } }));
    const metric = k === "notifyMissing" ? "notifications" : k;
    assert.equal(res.metrics[metric].status, "UNKNOWN", k); assert.equal(res.metrics[metric].counts, null); assert.equal(res.overall, "UNKNOWN");
    if (k === "pipeline") assert.equal(res.metrics.authorization.status, "UNKNOWN");
  }
  for (const pages of [[[{ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "NEW_CLASS", code: null, in_scope: true, age_min: 1 }]], [[{ op_id: 1 }]],
    [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "LATCHED", code: "lower", in_scope: true, age_min: 1 }]], Array.from({ length: 21 }, () => Array.from({ length: 100 }, () => ({ op_id: OID, intent_id: IID, template: "x", class: "SUCCEEDED", code: null, in_scope: true, age_min: 1 })))]) {
    const { res } = await core(world({ notifyPages: pages })); assert.deepEqual([res.metrics.notifications.status, res.overall], ["UNKNOWN", "UNKNOWN"]);
  }
  for (const refunds of [[{ y: 1 }], [{ x: { cancelled: false } }], [{ x: { cancelled: true, refundStatus: 3 } }], [{ x: [] }], [{ x: "pending" }], Array.from({ length: 501 }, () => ({ x: null }))]) {
    const { res } = await core(world({ refunds })); assert.deepEqual([res.metrics.refunds.status, res.overall], ["UNKNOWN", "UNKNOWN"], JSON.stringify(refunds).slice(0, 60));
  }
  const budget = await core(world(), { ...OPEN, budgets: { ...OPEN.budgets, statements: 5 } }); assert.deepEqual([budget.res.overall, budget.res.code], ["UNKNOWN", "STS_BUDGET"]);
  const badClock = await core(world(), OPEN, "not-a-time"); assert.deepEqual([badClock.res.overall, badClock.res.code], ["UNKNOWN", "STS_CLOCK_INVALID"]);
  const conn = await S.runStatusCore({ pool: { connect: async () => { throw new Error("SENTINEL"); } }, c: OPEN }); assert.deepEqual([conn.overall, conn.code], ["UNKNOWN", "STS_DB_FAILED"]);
  const excluded = await core(world({ notifyPages: [[{ op_id: OID, intent_id: "abede8b1-8ef6-44f2-876e-6a02fc056a96", template: "booking_confirmed", class: "UNKNOWN", code: null, in_scope: true, age_min: 1 }]] }));
  assert.equal(excluded.res.metrics.notifications.status, "OK", "an excluded historical intent is out of scope");
  const historic = await core(world({ notifyPages: [[{ op_id: OID, intent_id: IID, template: "booking_confirmed", class: "UNKNOWN", code: null, in_scope: false, age_min: 99999 }]] }));
  assert.equal(historic.res.metrics.notifications.status, "OK", "before the cutoff = out of scope");
});

test("T6b refunds (F1 closed 0027 shape + F2 same-snapshot completeness): SQL NULL and every valid label are reported faithfully (pending INFO, never pages); null / unknown / missing labels, extra keys, too few / too many rows and an unreadable prerequisite are UNKNOWN — never OK", async () => {
  assert.deepEqual([...S.REFUND_LABELS], ["pending", "none", "partial", "full"]);
  const agg = (confirmed) => ({ ...AGG, pipeline: { ...AGG.pipeline, total: confirmed, confirmed } });
  const lab = (refundStatus) => ({ x: { cancelled: true, refundStatus } });
  // valid: SQL NULL (not externally cancelled) + each label; counts are faithful; only pending → INFO; overall never pages
  const valid = [
    [[{ x: null }], "OK", { externallyCancelled: 0, refundPending: 0, refundNone: 0, refundPartial: 0, refundFull: 0 }],
    [[lab("pending")], "INFO", { externallyCancelled: 1, refundPending: 1, refundNone: 0, refundPartial: 0, refundFull: 0 }],
    [[lab("none")], "OK", { externallyCancelled: 1, refundPending: 0, refundNone: 1, refundPartial: 0, refundFull: 0 }],
    [[lab("partial")], "OK", { externallyCancelled: 1, refundPending: 0, refundNone: 0, refundPartial: 1, refundFull: 0 }],
    [[lab("full")], "OK", { externallyCancelled: 1, refundPending: 0, refundNone: 0, refundPartial: 0, refundFull: 1 }],
    [[{ x: null }, lab("pending"), lab("none"), lab("partial"), lab("full")], "INFO", { externallyCancelled: 4, refundPending: 1, refundNone: 1, refundPartial: 1, refundFull: 1 }]
  ];
  for (const [refunds, status, counts] of valid) {
    const { res } = await core(world({ refunds, agg: agg(refunds.length), scope: { n: refunds.length } }));
    assert.equal(res.metrics.refunds.status, status, JSON.stringify(refunds));
    assert.deepEqual(res.metrics.refunds.counts, { confirmedRead: refunds.length, ...counts });
    assert.equal(res.overall, "OK", "a valid refund label never pages");
    assert.match(res.metrics.refunds.scope, /execution unobserved/); assert.match(res.metrics.refunds.note, /not provider execution/);
  }
  // F1: the closed projection shape / enum
  const badShape = [lab(null), lab("unknown"), lab("Pending"), lab("refunded"), lab(""), lab(3), { x: { cancelled: true } }, { x: { refundStatus: "pending" } },
    { x: { cancelled: true, refundStatus: "pending", amount: 1 } }, { x: { cancelled: false, refundStatus: "pending" } }, { x: { cancelled: "true", refundStatus: "pending" } },
    { x: [] }, { x: "pending" }, { x: 0 }, { x: null, extra: 1 }, { y: null }, {}, null, []];
  for (const row of badShape) {
    const { res } = await core(world({ refunds: [row] }));
    assert.deepEqual([res.metrics.refunds.status, res.metrics.refunds.counts, res.overall], ["UNKNOWN", null, "UNKNOWN"], JSON.stringify(row));
    assert.match(res.metrics.refunds.code, /^(REFUND_SHAPE|REPLY_SHAPE)$/);
  }
  // F2: cardinality must equal the validated pr.confirmed of the same snapshot
  for (const [refunds, confirmed] of [[[], 1], [[{ x: null }], 2], [[{ x: null }, { x: null }], 1], [[lab("pending")], 0], [Array.from({ length: 501 }, () => ({ x: null })), 1]]) {
    const { res } = await core(world({ refunds, agg: agg(confirmed) }));
    assert.deepEqual([res.metrics.refunds.status, res.overall], ["UNKNOWN", "UNKNOWN"], `${refunds.length} rows vs confirmed ${confirmed}`);
    assert.match(res.metrics.refunds.code, /^(ROW_COUNT_MISMATCH|REPLY_SHAPE)$/);
  }
  const zero = await core(world({ refunds: [], agg: agg(0) })); assert.deepEqual([zero.res.metrics.refunds.status, zero.res.metrics.refunds.counts.confirmedRead], ["OK", 0], "zero confirmed + zero rows is complete");
  // unreadable prerequisite aggregate (pipeline) → refunds UNKNOWN even with a well-formed projection
  for (const raw of [{ rows: [] }, { rows: [{ ...AGG.pipeline, confirmed: -1 }] }, { rows: [{ ...AGG.pipeline, confirmed: "1" }] }, { rows: [{ ...AGG.pipeline, extra: 0 }] }]) {
    const { res } = await core(world({ raw: { pipeline: raw } }));
    assert.deepEqual([res.metrics.pipeline.status, res.metrics.refunds.status, res.metrics.refunds.code, res.overall], ["UNKNOWN", "UNKNOWN", "PREREQUISITE_UNREADABLE", "UNKNOWN"], JSON.stringify(raw)?.slice(0, 60));
  }
  // the pure classifier agrees, and never reads anything
  assert.equal(S.classifyRefunds({ rows: [lab("pending")] }, null, 500, "s", "sc").code, "PREREQUISITE_UNREADABLE");
  assert.equal(S.classifyRefunds({ rows: [lab("pending")] }, 1, 500, "s", "sc").status, "INFO");
});

test("T7 hosted gates (seam): status needs ONLY the DB secret, both 64-hex digests (source exact, closure == pin), main, the run id, the pinned pg / DB target / CA; refused before any pool / core; ONE pool (max 1); the secret is removed from env; ATTENTION / UNKNOWN exit 1, OK / WAIT exit 0; preflight / verify take no secret", async () => {
  const SOURCE = await S.framedDigest(ROOT, C.runnerFiles, S.SOURCE_DIGEST_PREFIX);
  const gated = (over = {}) => ({ E7_TOOLING_DIR: TOOLING, E7_EXPECTED_SOURCE_DIGEST: SOURCE, E7_EXPECTED_CLOSURE_DIGEST: C.closureDigest, E7_WORKFLOW_SHA: "1".repeat(40), E7_RUN_ID: "123456789-1",
    GITHUB_REF: "refs/heads/main", E7_CA_FILE: "/ca", ...over });
  const mk = (overall = "OK") => { const st = { pools: 0, maxes: [], core: 0, ended: 0 }; return { st, deps: { constants: OPEN, readPgVersion: async () => "8.18.0", readCa: async () => Buffer.from("FAKE-CA"), caSha256: sha(Buffer.from("FAKE-CA")),
    importPool: async () => ({ createBookingPool: (cfg) => { st.pools += 1; st.maxes.push(cfg.max); return { end: async () => { st.ended += 1; } }; } }),
    runCore: async (a) => { st.core += 1; st.asOf = a.asOf; return Object.freeze({ overall, metrics: {} }); } } }; };
  for (const [overall, exit] of [["OK", 0], ["WAIT", 0], ["ATTENTION", 1], ["UNKNOWN", 1]]) {
    const m = mk(overall); const env = gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL });
    const r = await S.runHosted({ mode: "status", env, proc: PROC, wrapperDir: ROOT, deps: m.deps });
    assert.deepEqual([r.exitCode, r.result.code, m.st.pools, m.st.maxes, m.st.core, m.st.asOf, m.st.ended, Object.hasOwn(env, "E7_DEV_BOOKING_DATABASE_URL")], [exit, "STATUS_DONE", 1, [1], 1, null, 1, false], overall);
    assert.doesNotMatch(JSON.stringify(r) + S.summaryMarkdown(r.result), PII);
  }
  for (const [mode, over, code] of [["verify", { E7_DEV_BOOKING_DATABASE_URL: DBURL }, "STS_SECRET_SCOPE_VIOLATION"], ["preflight", { E7_DEV_BOOKING_DATABASE_URL: DBURL }, "STS_SECRET_SCOPE_VIOLATION"],
    ["status", {}, "STS_CREDENTIALS_MISSING"], ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_INTENT_ID: IID }, "STS_INPUT_UNEXPECTED"], ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_SQL: "SELECT 1" }, "STS_INPUT_UNEXPECTED"],
    ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_SOURCE_DIGEST: "f".repeat(64) }, "STS_SOURCE_MISMATCH"], ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_CLOSURE_DIGEST: "f".repeat(64) }, "STS_CLOSURE_MISMATCH"],
    ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_EXPECTED_SOURCE_DIGEST: "" }, "STS_INPUT_INCOMPLETE"], ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, GITHUB_REF: "refs/heads/x" }, "STS_REF_NOT_MAIN"],
    ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_RUN_ID: "x" }, "STS_INPUT_INVALID"], ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL.replace("mv_booking_app_dev", "postgres") }, "STS_DB_TARGET_INVALID"],
    ["status", { E7_DEV_BOOKING_DATABASE_URL: DBURL, E7_TOOLING_DIR: ROOT }, "STS_LAYOUT_INVALID"]]) {
    const m = mk(); const r = await S.runHosted({ mode, env: gated(over), proc: PROC, wrapperDir: ROOT, deps: m.deps });
    assert.deepEqual([r.exitCode, r.result.code, m.st.pools, m.st.core], [1, code, 0, 0], `${mode} ${code}`); assert.doesNotMatch(JSON.stringify(r), PII);
  }
  const ca = mk(); const rc = await S.runHosted({ mode: "status", env: gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: { ...ca.deps, readCa: async () => Buffer.from("OTHER") } });
  assert.deepEqual([rc.result.code, ca.st.pools], ["STS_CA_INVALID", 0]);
  const pgv = mk(); const rp = await S.runHosted({ mode: "status", env: gated({ E7_DEV_BOOKING_DATABASE_URL: DBURL }), proc: PROC, wrapperDir: ROOT, deps: { ...pgv.deps, readPgVersion: async () => "8.17.0" } });
  assert.equal(rp.result.code, "STS_DEPENDENCY_MISMATCH");
  const v = await S.runHosted({ mode: "verify", env: gated(), proc: PROC, wrapperDir: ROOT, deps: mk().deps }); assert.deepEqual([v.exitCode, v.result.code], [0, "VERIFY_OK"]);
  const p = await S.runHosted({ mode: "preflight", env: { E7_TOOLING_DIR: TOOLING }, proc: PROC, wrapperDir: ROOT, deps: { importPool: never("pool"), runCore: never("core") } });
  assert.deepEqual([p.exitCode, p.result.code, p.result.sourceDigest, p.result.closureDigest], [0, "PREFLIGHT_OK", SOURCE, C.closureDigest], "manual preflight: digests only, shipped constants");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// OPT-IN REAL DISPOSABLE POSTGRESQL at schema 28 (C119 S4) — the REAL core, synthetic fixtures (pinned tooling) and a synthetic clock
if (process.env.E7_HST_DB_TESTS === "1") {
  const tool = (p) => import(pathToFileURL(join(TOOLING, p)).href);
  const H = await tool("test/db/harness.mjs"); const F = await tool("test/db/fixtures.mjs"); const MG = await tool("db/lib/migrate.js");
  const pg = createRequire(join(TOOLING, "package.json"))("pg");
  // C119 S4: schema 28 = the pinned tooling's 0001..0026 + the 0027 + C119 S4 0028 bytes (sha-checked) from E7_SCHEMA28_DIR (a C119 S4 tooling checkout)
  const S28 = realpathSync(process.env.E7_SCHEMA28_DIR || join(ROOT, "..", "schema28"));
  const M28 = { "0027_external_cancellation_disposition.up.sql": "ae949bf42450cf1af2632212f2cc2c2704b66ca314f4fc4f2744e6130f9c8ecf",
    "0027_external_cancellation_disposition.down.sql": "8e3810678bc788df6915a4be9c728296a89f0b040ae0df245ceef7583fc6ba6c",
    "0028_pipeline_kickoff_source_rebind_s4.up.sql": "a72d2ce911cac924b728525f1af43b547c7e908a96bdecbf84f41ca3ebfa3642",
    "0028_pipeline_kickoff_source_rebind_s4.down.sql": "c247b17883b23ecdba1eb0ec2a94e5e0e9caa558724ee29c4b0500fb7b77806f" };
  const MDIR = mkdtempSync(join(tmpdir(), "e7-s4-m28-"));
  for (const f of readdirSync(join(TOOLING, "db/migrations"))) writeFileSync(join(MDIR, f), readFileSync(join(TOOLING, "db/migrations", f)));
  for (const [f, h] of Object.entries(M28)) { const b = readFileSync(join(S28, "db/migrations", f)); assert.equal(sha(b), h, f); writeFileSync(join(MDIR, f), b); }
  // the accepted gn-v2 lifecycle helpers (USD bookings with an .invalid synthetic guest, the REAL accepted workers), generated from the pinned tooling's
  // test/db/e7-gn-v2-resend-integration.test.mjs exactly as the C50 runner's DB tests do (sha-checked; imports rewritten to the tooling checkout)
  const SRC = "test/db/e7-gn-v2-resend-integration.test.mjs"; const SRC_SHA = "1c847a2d6ade0e3aa3f7e8bbdeb7727a4456cb49ad93ecdbe3b9be56ac5d63a0";
  const text = readFileSync(join(TOOLING, SRC), "utf8"); assert.equal(sha(text), SRC_SHA, "the pinned accepted helper source");
  const tdir = mkdtempSync(join(tmpdir(), "e7-s3-helpers-"));
  const turl = (rel) => pathToFileURL(join(TOOLING, "test/db", rel)).href;
  let mod = text.slice(0, text.indexOf("// provider harness"));
  mod = mod.replace(/^import \{ test, before, after \} from "node:test";\n/m, "").replace(/from "(\.\.?\/[^"]+)"/g, (_, rel) => `from "${turl(rel)}"`);
  const g0 = mod.indexOf("let netAttempts = 0;"); const g1 = mod.indexOf("syncBuiltinESMExports();", g0) + "syncBuiltinESMExports();".length;
  mod = mod.slice(0, g0) + "// (network guard of the source suite removed: this file installs its own)\n" + mod.slice(g1);
  mod = mod.replace('let db;\nbefore(async () => { db = await startMigratedDatabase(); });\nafter(async () => { globalThis.fetch = realFetch; await db.close(); });', "let db; export const __setDb = (x) => { db = x; };");
  assert.ok(mod.includes("export const __setDb") && !/^(before|after|test)\(/m.test(mod), "helper module rewritten as reviewed");
  mod += "\nexport { confirmedBooking, notifyOf };\n";
  writeFileSync(join(tdir, "helpers.mjs"), mod);
  symlinkSync(join(TOOLING, "node_modules"), join(tdir, "node_modules"));
  const Hm = await import(pathToFileURL(join(tdir, "helpers.mjs")).href);
  const db = await H.startMigratedDatabase(); Hm.__setDb(db);
  assert.deepEqual(await MG.migrateUp(db.owner, { env: "test", dir: MDIR }), [27, 28]);
  const reportPool = new pg.Pool({ connectionString: db.reportUrl(), max: 2 });
  after(async () => { await reportPool.end(); await db.close(); rmSync(MDIR, { recursive: true, force: true }); rmSync(tdir, { recursive: true, force: true }); });
  const L = 606998;
  const C0 = Object.freeze({ ...OPEN, scope: Object.freeze({ ...OPEN.scope, cutoff: "2026-01-01T00:00:00.000Z" }) });   // TEST-LOCAL: the fixtures' clock predates the reviewed cutoff
  let day = 0; const stay = (listingId = L, extra = {}) => { day += 3; const d = (n) => new Date(Date.UTC(2027, 0, 1) + n * 86400000).toISOString().slice(0, 10); return { listingId, from: d(day), to: d(day + 2), ...extra }; };
  const cOf = (listingId) => Object.freeze({ ...C0, listingId });   // TEST-LOCAL: one synthetic listing per scenario keeps the scenarios independent
  const one = async (sql, p = []) => (await db.owner.query(sql, p)).rows[0];
  const run = (asOf, c = C0, pool = db.app) => S.runStatusCore({ pool, c, asOf });
  const runL = (listingId, asOf) => run(asOf, cOf(listingId));
  const iso = (t, mins) => new Date(new Date(t).getTime() + mins * 60000).toISOString();
  const tableFingerprint = async () => (await db.owner.query(`SELECT jsonb_object_agg(t.relname, x.v) AS f FROM pg_class t JOIN pg_namespace s ON s.oid = t.relnamespace,
      LATERAL (SELECT (xpath('/row/v/text()', query_to_xml(format('SELECT count(*) || '':'' || md5(coalesce(string_agg(to_jsonb(x)::text, E''\\n'' ORDER BY to_jsonb(x)::text), '''')) AS v FROM booking.%I x', t.relname), false, true, '')))[1]::text AS v) x
      WHERE s.nspname = 'booking' AND t.relkind = 'r'`)).rows[0].f;
  const notifyOf = async (id) => one("SELECT id, created_at FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [id]);

  test("D0 empty TEST scope on schema 28 (the real runtime role): overall OK, every metric OK with zero counts — and ONE read-only snapshot writes NOTHING", async () => {
    const f0 = await tableFingerprint(); const r = await run(null);
    assert.deepEqual([r.overall, r.code, r.clock, r.scope.intents], ["OK", "STATUS_OK", "database", 0], JSON.stringify(r));
    for (const m of Object.values(r.metrics)) assert.equal(m.status, "OK");
    assert.deepEqual(await tableFingerprint(), f0, "zero writes");
  });

  test("D1 pipeline + authorization horizon on a REAL authorized intent with a synthetic clock: a recent authorization is a healthy WAIT; past the stall threshold → ACTION (silent PENDING / stalled); the stored capture_before within 48 h → ACTION; far from it → WAIT. (A missing capture_before is impossible here — the auth_exact constraint — and is covered as UNKNOWN by T4 / T5.)", async () => {
    const LL = 700001; const a = await F.authorized(db.app, stay(LL));
    const i = await one("SELECT updated_at, capture_before FROM booking.intents WHERE id = $1", [a.id]);
    const early = await runL(LL, iso(i.updated_at, 5));
    assert.deepEqual([early.metrics.pipeline.status, early.metrics.pipeline.counts.inPipeline, early.metrics.authorization.status, early.overall], ["WAIT", 1, "WAIT", "WAIT"]);
    const stale = await runL(LL, iso(i.updated_at, 31));
    assert.deepEqual([stale.metrics.pipeline.status, stale.metrics.pipeline.counts.stalled, stale.overall], ["ACTION", 1, "ATTENTION"]);
    const near = await runL(LL, iso(i.capture_before, -60));
    assert.deepEqual([near.metrics.authorization.status, near.metrics.authorization.counts.nearExpiry, near.metrics.authorization.counts.minRemainingMin], ["ACTION", 1, 60]);
    const far = await runL(LL, iso(i.capture_before, -3 * 1440));
    assert.equal(far.metrics.authorization.status, "WAIT");
  });

  test("D2 confirmations on REAL confirmed bookings: an ELIGIBLE confirmation younger than 90 min WAITs, older → ACTION (confirmed but unsent); a SUCCEEDED one is OK; one LATCHED by a REAL owner-recorded external cancellation is INFO with its pending manual refund INFO — the C116 shape never pages (overall OK)", async () => {
    const LL = 700002; const e = await Hm.confirmedBooking({ listingId: LL }); const op = await notifyOf(e.id);
    const w = await runL(LL, iso(op.created_at, 10));
    assert.deepEqual([w.metrics.notifications.status, w.metrics.notifications.counts.eligibleRecent], ["WAIT", 1], JSON.stringify(w.metrics.notifications));
    const a = await runL(LL, iso(op.created_at, 120));
    assert.deepEqual([a.metrics.notifications.status, a.metrics.notifications.counts.eligibleStale, a.overall], ["ACTION", 1, "ATTENTION"]);
    // sent (TEST SETUP: the durable succeeded shape), then a second booking cancelled externally BEFORE its send (the real 0027 admin path)
    await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET state = 'succeeded', attempts = 1, completed_at = now(), result_ref = 'resend:s3' WHERE id = $1", [op.id]);
    const x = await Hm.confirmedBooking({ listingId: LL });
    const res = await one("SELECT hostaway_reservation_id AS r, version AS v FROM booking.intents WHERE id = $1", [x.id]);
    const ev = (await db.reconciler.query("SELECT booking.admin_record_evidence($1,$2,$3,$4,$5,$6,$7,$8) AS id", [x.id, "hostaway_reservation", String(res.r), "cancelled", {}, new Date(), "owner", "hostaway-dashboard-cancelled"])).rows[0].id;
    await db.reconciler.query("SELECT booking.admin_record_external_cancellation($1,$2,$3::uuid[],$4,$5,$6,$7,$8,$9,$10,$11) AS r", [x.id, res.v, [ev], ev, "pending", null, null, "owner", "hostaway-dash-s3", "OWNER_CANCELLED_IN_HOSTAWAY", "s3-key-1"]);
    const xop = await notifyOf(x.id);
    const s = await runL(LL, iso(xop.created_at, 600));
    const n = s.metrics.notifications.counts;
    assert.deepEqual([n.succeeded, n.latchedExternallyCancelled, n.eligibleStale], [1, 1, 0], JSON.stringify(n));
    assert.deepEqual([s.metrics.notifications.status, s.metrics.refunds.status, s.metrics.refunds.counts.externallyCancelled, s.metrics.refunds.counts.refundPending], ["INFO", "INFO", 1, 1]);
    assert.equal(s.overall, "OK", `the expected pending manual refund / cancellation-latched confirmation never page: ${JSON.stringify(Object.fromEntries(Object.entries(s.metrics).map(([k, v]) => [k, v.status])))}`);
    assert.doesNotMatch(JSON.stringify(s), /@|mv-test|MV-T|pi_test|hostaway-dash|s3-key|resend:s3/, "no guest / ref / provider / key value in the output");
    for (const id of [e.id, x.id]) assert.ok(!JSON.stringify(s).includes(id));
  });

  test("D3 operations / cases / work leases (REAL rows, TEST SETUP on the owner side): an outcome_unknown write, an expired op lease, an open reconciliation case and an expired work lease are each ACTION; a confirmed intent with no notify op at all is ACTION (structural); the MXN fixture's out-of-scope confirmation is ACTION, not silently skipped", async () => {
    const LL = 700003; const c = await F.captured(db.app, stay(LL));
    const capOp = await one("SELECT id FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'stripe.capture_payment_intent'", [c.id]);
    const before = await runL(LL, null);
    await F.ownerManagedHistory(db.owner, "UPDATE booking.external_operations SET state = 'outcome_unknown' WHERE id = $1", [capOp.id]);
    const u = await runL(LL, null); assert.deepEqual([u.metrics.operations.status, u.metrics.operations.counts.outcome_unknown - before.metrics.operations.counts.outcome_unknown], ["ACTION", 1]);
    await F.ownerManagedHistory(db.owner, "INSERT INTO booking.reconciliation_cases (id, intent_id, kind, status, opened_at, opened_by, evidence) VALUES (gen_random_uuid(), $1, 'S3_TEST', 'open', now(), 'owner', '{}'::jsonb)", [c.id]);
    const k = await runL(LL, null); assert.deepEqual([k.metrics.cases.status, k.metrics.cases.counts.open], ["ACTION", 1]);
    await F.ownerManagedHistory(db.owner, "UPDATE booking.intent_work SET work_worker_id = 'w-s3', work_lease_until = now() - interval '5 minutes' WHERE intent_id = $1", [c.id]);
    const wl = await runL(LL, null); assert.deepEqual([wl.metrics.work.status, wl.metrics.work.counts.lease_expired >= 1], ["ACTION", true]);
    const m = await F.confirmed(db.app, stay(LL));                                                   // MXN + an .example.test guest: out of v1 scope
    const mo = await runL(LL, null); assert.ok(mo.metrics.notifications.counts.attentionClass >= 1, JSON.stringify(mo.metrics.notifications.counts)); assert.equal(mo.metrics.notifications.status, "ACTION");
    await F.ownerManagedHistory(db.owner, "DELETE FROM booking.notification_latches WHERE operation_id IN (SELECT id FROM booking.external_operations WHERE intent_id = $1)", [m.id]);
    await F.ownerManagedHistory(db.owner, "DELETE FROM booking.external_operations WHERE intent_id = $1 AND op_type = 'guest.notify'", [m.id]);   // TEST SETUP: a structurally missing op
    const mi = await runL(LL, null); assert.deepEqual([mi.metrics.notifications.counts.confirmedWithoutNotify, mi.metrics.notifications.status], [1, "ACTION"]);
  });

  test("D4 kickoff requests (REAL table, TEST SETUP rows on the TEST listing): a recent request is WAIT, one older than 90 min ACTION; a stale claim, a dispatch_unknown, an accepted dispatch whose intent never left payment_authorized and a refusal whose intent is still authorized are ACTION; a refusal of a closed intent is INFO", async () => {
    const a = await F.authorized(db.app, stay()); const ia = await one("SELECT id, ref, version, stripe_payment_intent_id AS pi, authorized_minor AS amt, state FROM booking.intents WHERE id = $1", [a.id]);
    const t0 = "2026-11-20T12:00:00.000Z";
    const ins = (o) => F.ownerManagedHistory(db.owner, `INSERT INTO booking.pipeline_kickoff_requests (intent_id, ref, authorized_version, payment_intent_id, amount_minor, currency, listing_id, intent_created_at, requested_at, state,
      claim_worker, claimed_at, plan_hash, dispatch_inputs, settled_at, outcome_code) VALUES ($1, $2, $3, $4, $5, 'USD', 606998, '2026-11-16T00:00:00Z', $6, $7, $8, $9, $10, $11, $12, $13)`,
      [o.id, o.ref, o.version, o.pi, o.amt, o.requestedAt, o.state, o.worker ?? null, o.claimedAt ?? null, o.plan ?? null, o.inputs ?? null, o.settledAt ?? null, o.outcome ?? null]);
    const k = async (asOf) => (await run(asOf)).metrics.kickoff;
    await ins({ ...ia, requestedAt: iso(t0, -10), state: "requested" });
    let m = await k(t0); assert.deepEqual([m.status, m.counts.requested, m.counts.oldest_requested_min], ["WAIT", 1, 10]);
    m = await k(iso(t0, 85)); assert.deepEqual([m.status, m.counts.requested_stale], ["ACTION", 1], "older than 90 min");
    await F.ownerManagedHistory(db.owner, "UPDATE booking.pipeline_kickoff_requests SET state = 'claimed', claim_worker = 'w', claimed_at = $2, plan_hash = $3, dispatch_inputs = '{}'::jsonb WHERE intent_id = $1", [a.id, iso(t0, -20), "a".repeat(64)]);
    m = await k(t0); assert.deepEqual([m.status, m.counts.claimed_stale], ["ACTION", 1]);
    for (const [state, want] of [["dispatch_unknown", "ACTION"], ["dispatch_accepted", "ACTION"], ["dispatch_refused", "ACTION"]]) {
      await F.ownerManagedHistory(db.owner, "UPDATE booking.pipeline_kickoff_requests SET state = $2, settled_at = $3, outcome_code = 'S3' WHERE intent_id = $1", [a.id, state, iso(t0, -40)]);
      m = await k(t0); assert.equal(m.status, want, state);
    }
    await F.ownerManagedHistory(db.owner, "UPDATE booking.intents SET state = 'authorization_released' WHERE id = $1", [a.id]);
    m = await k(t0); assert.deepEqual([m.status, m.counts.refused, m.counts.refused_still_authorized], ["INFO", 1, 0], "a refusal of a closed intent is informational");
  });

  test("D5 permissions / identity / bounds on the REAL database: the owner, the admin login and the report login are each refused STS_ROLE_REFUSED (only the runtime role reads); a revoked runtime grant changes the catalog → STS_CATALOG_NOT_28; a faulted statement → UNKNOWN with no metrics; maxIntents below the scope → STS_SCOPE_TOO_LARGE (never a partial OK); a non-TEST instance marker → STS_NOT_TEST; zero writes throughout", async () => {
    const f0 = await tableFingerprint();
    for (const pool of [db.owner, db.reconciler, reportPool]) { const r = await run(null, C0, pool); assert.deepEqual([r.overall, r.code, r.metrics], ["UNKNOWN", "STS_ROLE_REFUSED", {}]); }
    await db.owner.query("REVOKE EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) FROM mv_booking_app");
    try { const r = await run(null); assert.deepEqual([r.overall, r.code], ["UNKNOWN", "STS_CATALOG_NOT_28"]); }
    finally { await db.owner.query("GRANT EXECUTE ON FUNCTION booking.external_cancellation_public(uuid) TO mv_booking_app"); }
    for (const victim of [Q.kickoff, Q.notifyPage, Q.refunds]) {
      const faulty = { connect: async () => { const cl = await db.app.connect(); return { query: (t, p) => (t === victim ? Promise.reject(new Error("permission denied SENTINEL")) : cl.query(t, p)), release: (x) => cl.release(x) }; } };
      const r = await run(null, C0, faulty); assert.deepEqual([r.overall, r.code, r.metrics], ["UNKNOWN", "STS_DB_FAILED", {}]); assert.doesNotMatch(JSON.stringify(r), /SENTINEL/);
    }
    const big = await run(null, { ...C0, scope: { ...C0.scope, maxIntents: 0 } }); assert.deepEqual([big.overall, big.code], ["UNKNOWN", "STS_SCOPE_TOO_LARGE"]);
    await F.ownerManagedHistory(db.owner, "UPDATE booking.instance SET environment = 'live'");
    try { const r = await run(null); assert.deepEqual([r.overall, r.code], ["UNKNOWN", "STS_NOT_TEST"]); }
    finally { await F.ownerManagedHistory(db.owner, "UPDATE booking.instance SET environment = 'test'"); }
    assert.deepEqual(await tableFingerprint(), f0, "the status runner itself wrote nothing");
    const ok = await run(null); assert.notEqual(ok.code, "STS_ROLE_REFUSED");
  });
}
