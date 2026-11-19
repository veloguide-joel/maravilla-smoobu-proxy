// C123 focused tests for scripts/e7-test-auto-availability-check.mjs + its workflow. Fakes only: no network, no database, no secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as M from "../scripts/e7-test-auto-availability-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/e7-test-auto-availability-check.mjs";
const WF = ".github/workflows/e7-test-auto-availability-check.yml";
const TODAY = "2026-11-19";
const TOKEN = "tok_SECRET_abc123";
const range = (a, b) => { const r = M.validateRange(a, b, TODAY); assert.ok(r.ok, JSON.stringify(r)); return r; };

// ---- fake https.request: records every call; replies with a scripted status / body ----
function fakeRequest(reply) {
  const calls = [];
  const fn = (opts, cb) => {
    const req = new EventEmitter(); req.written = []; req.destroyed = false;
    req.write = (x) => { req.written.push(x); }; req.destroy = () => { req.destroyed = true; };
    req.end = (x) => {
      if (x !== undefined) req.written.push(x);
      calls.push({ opts, written: req.written });
      setImmediate(() => {
        if (reply.error) return req.emit("error", reply.error);
        if (reply.timeout) return req.emit("timeout");
        const res = new EventEmitter(); res.statusCode = reply.status; res.headers = reply.headers ?? {}; res.destroy = () => {};
        cb(res);
        setImmediate(() => { for (const c of [].concat(reply.body ?? [])) res.emit("data", Buffer.from(c)); res.emit("end"); });
      });
    };
    return req;
  };
  fn.calls = calls;
  return fn;
}
const day = (date, status = "available", isAvailable = 1, extra = {}) => ({ date, status, isAvailable, note: "PRIVATE NOTE", reservations: [{ guestName: "Jane Guest", id: 123 }], ...extra });
const body = (days) => JSON.stringify({ status: "success", result: days });

// ---- fake pg client: records every SQL text; scripted rows ----
function fakeClient({ identity = { cu: "mv_booking_app_dev", ro: "on", n: 1, env: "test" }, claims = [], failOn = null, connectError = null } = {}) {
  const sql = [];
  return {
    sql, ended: false,
    async connect() { if (connectError) throw connectError; },
    async query(text, params) {
      sql.push({ text, params });
      if (failOn && text.startsWith(failOn)) { const e = new Error("relation secret_detail does not exist"); e.code = "42P01"; throw e; }
      if (text === M.SQL.identity) return { rows: [identity] };
      if (text === M.SQL.claims) return { rows: claims };
      return { rows: [] };
    },
    async end() { this.ended = true; },
  };
}

test("A1 input bounds: strict ISO dates, real calendar days, half-open ≥1 night, ≤31 nights, not in the past, ≤730 days ahead", () => {
  assert.deepEqual(range("2026-12-20", "2026-12-21").nights, ["2026-12-20"]);
  assert.deepEqual(range("2026-12-30", "2027-01-02").nights, ["2026-12-30", "2026-12-31", "2027-01-01"]);
  assert.equal(range("2026-12-01", "2027-01-01").nights.length, 31);
  const bad = [
    ["2026-12-01", "2027-01-02", "RANGE_TOO_LONG"], ["2026-12-20", "2026-12-20", "RANGE_EMPTY_OR_REVERSED"], ["2026-12-21", "2026-12-20", "RANGE_EMPTY_OR_REVERSED"],
    ["2026-02-30", "2026-03-02", "CHECK_IN_INVALID"], ["2026-12-1", "2026-12-03", "CHECK_IN_INVALID"], ["2026-12-01", "20261203", "CHECK_OUT_INVALID"],
    [" 2026-12-01", "2026-12-03", "CHECK_IN_INVALID"], ["2026-12-01;rm", "2026-12-03", "CHECK_IN_INVALID"], [undefined, "2026-12-03", "CHECK_IN_INVALID"],
    ["2026-11-18", "2026-11-20", "CHECK_IN_IN_PAST"], ["2028-11-20", "2028-11-21", "CHECK_IN_TOO_FAR"],
  ];
  for (const [a, b, code] of bad) assert.deepEqual(M.validateRange(a, b, TODAY), { ok: false, code }, `${a} → ${b}`);
  assert.equal(M.validateRange("2026-11-19", "2026-11-20", TODAY).ok, true, "today is allowed");
});

test("H1 exact GET target: ONE GET to api.hostaway.com:443 /v1/listings/606998/calendar?startDate=<in>&endDate=<out>, the three accepted headers, no body", async () => {
  const req = fakeRequest({ status: 200, body: body([day("2026-12-20"), day("2026-12-21")]) });
  const r = await M.readHostawayCalendar({ token: TOKEN, range: range("2026-12-20", "2026-12-21"), request: req });
  assert.equal(r.ok, true);
  assert.equal(req.calls.length, 1);
  const o = req.calls[0].opts;
  assert.equal(o.method, "GET"); assert.equal(o.host, "api.hostaway.com"); assert.equal(o.port, 443); assert.equal(o.timeout, 8000);
  assert.equal(o.path, "/v1/listings/606998/calendar?startDate=2026-12-20&endDate=2026-12-21");
  const u = new URL(`https://x${o.path}`);
  assert.deepEqual([...u.searchParams.keys()].sort(), ["endDate", "startDate"], "exactly the pipeline isCalendarUrl query keys (no includeResources)");
  assert.deepEqual(Object.keys(o.headers).sort(), ["Accept", "Authorization", "Cache-control"]);
  assert.equal(o.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(o.headers["Cache-control"], "no-cache");
  assert.deepEqual(req.calls[0].written, [], "no request body");
  assert.equal(M.calendarRequestOptions(range("2026-12-20", "2026-12-22"), "t").path.includes("606998"), true, "listing is the fixed literal");
});

test("H2 fail closed on transport: 3xx (no follow), 4xx, 5xx, timeout, socket error, invalid JSON, oversize body, bad token; exactly one request, never a retry", async () => {
  const R = range("2026-12-20", "2026-12-21");
  const cases = [
    [{ status: 301, headers: { location: "https://evil.example/" } }, "REDIRECT_REFUSED"], [{ status: 401 }, "HTTP_4XX"], [{ status: 403 }, "HTTP_4XX"],
    [{ status: 503 }, "HTTP_5XX"], [{ timeout: true }, "TIMEOUT"], [{ error: Object.assign(new Error("x"), { code: "ECONNRESET" }) }, "REQUEST_ECONNRESET"],
    [{ status: 200, body: "<html>not json" }, "JSON_INVALID"], [{ status: 200, body: ["x".repeat(600 * 1024), "y".repeat(600 * 1024)] }, "BODY_TOO_LARGE"],
    [{ status: 200, body: JSON.stringify({ status: "fail", result: [] }) }, "SHAPE_STATUS_NOT_SUCCESS"], [{ status: 200, body: JSON.stringify({ status: "success" }) }, "SHAPE_NO_RESULT_ARRAY"],
  ];
  for (const [reply, code] of cases) {
    const req = fakeRequest(reply);
    const r = await M.readHostawayCalendar({ token: TOKEN, range: R, request: req });
    assert.equal(r.ok, false, code); assert.equal(r.code, code); assert.equal(req.calls.length, 1, `${code}: one request, no retry / follow`);
    assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes("evil"), `${code}: sanitized`);
  }
  for (const [tok, code] of [["", "TOKEN_MISSING"], ["has space", "TOKEN_SHAPE"]]) {
    const req = fakeRequest({ status: 200, body: "[]" });
    assert.equal((await M.readHostawayCalendar({ token: tok, range: R, request: req })).code, code); assert.equal(req.calls.length, 0, "no request without a valid token");
  }
});

test("H3 per-night classification (lib/bookability nightIsOpen rule): available / blocked / unknown; missing, duplicate and contradictory days are unknown", () => {
  const nights = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06", "2026-12-07"];
  const r = M.classifyCalendar({ status: "success", result: [
    day("2026-12-01"), day("2026-12-02", "reserved", 0), day("2026-12-03", "available", 0), day("2026-12-04", "blocked", 1),
    day("2026-12-05"), day("2026-12-05"), { date: "2026-12-06", isAvailable: 1 },
  ] }, nights);
  assert.deepEqual(r.nights, { "2026-12-01": "available", "2026-12-02": "blocked", "2026-12-03": "blocked", "2026-12-04": "unknown",
    "2026-12-05": "unknown", "2026-12-06": "unknown", "2026-12-07": "unknown" });
  assert.equal(M.classifyDay(day("2026-12-01", "available", true)), "available");
});

test("H4 response forms = the pinned lib/hostaway-calendar.js contract: top-level array OR {result:[…]} (status, if present, must be success); empty / malformed fail closed", async () => {
  const nights = ["2026-12-01", "2026-12-02"];
  const days = [day("2026-12-01"), day("2026-12-02", "reserved", 0)];
  const want = { ok: true, nights: { "2026-12-01": "available", "2026-12-02": "blocked" } };
  assert.deepEqual(M.classifyCalendar(days, nights), want, "top-level array");
  assert.deepEqual(M.classifyCalendar({ result: days }, nights), want, "wrapper without status");
  assert.deepEqual(M.classifyCalendar({ status: "success", result: days }, nights), want, "wrapper with status success");
  const req = fakeRequest({ status: 200, body: JSON.stringify(days) });
  assert.deepEqual(await M.readHostawayCalendar({ token: TOKEN, range: range("2026-12-01", "2026-12-03"), request: req }),
    { ok: true, code: "CALENDAR_READ", http: 200, nights: { "2026-12-01": "available", "2026-12-02": "blocked" } }, "top-level array end to end");
  const fails = [
    [[], "SHAPE_EMPTY"], [{ result: [] }, "SHAPE_EMPTY"], [{ status: "success", result: [] }, "SHAPE_EMPTY"],
    [{ status: "fail", result: days }, "SHAPE_STATUS_NOT_SUCCESS"], [{ status: null, result: days }, "SHAPE_STATUS_NOT_SUCCESS"],
    [{ status: "success" }, "SHAPE_NO_RESULT_ARRAY"], [{ status: "success", result: { "2026-12-01": days[0] } }, "SHAPE_NO_RESULT_ARRAY"], [{}, "SHAPE_NO_RESULT_ARRAY"],
    [null, "SHAPE_UNEXPECTED"], ["days", "SHAPE_UNEXPECTED"], [42, "SHAPE_UNEXPECTED"],
  ];
  for (const [j, code] of fails) assert.deepEqual(M.classifyCalendar(j, nights), { ok: false, code }, JSON.stringify(j));
  // malformed entries inside an accepted form never make a night available: they are ignored, so the night is unknown
  assert.deepEqual(M.classifyCalendar([null, "x", 7, { date: "2026-12-1", status: "available", isAvailable: 1 }, { date: "2026-12-01T00:00:00Z", status: "available", isAvailable: 1 }], nights),
    { ok: true, nights: { "2026-12-01": "unknown", "2026-12-02": "unknown" } });
  assert.deepEqual(M.classifyCalendar([day("2026-12-01"), day("2026-12-01")], nights).nights["2026-12-01"], "unknown", "duplicate date in a top-level array");
  assert.equal(M.classifyDay(day("2026-12-01", "available", "1")), "unknown", "string flags are not trusted");
});

test("D1 DB read is read-only: exactly BEGIN READ ONLY → identity → ONE claims SELECT (fixed listing 606998, half-open window) → ROLLBACK; no write verb", async () => {
  const c = fakeClient({ claims: [{ f: "2026-12-15", t: "2026-12-16", li: true, ui: false, id: 77, intent_id: "11111111-2222-3333-4444-555555555555" }] });
  const R = range("2026-12-14", "2026-12-17");
  const r = await M.readClaims({ client: c, range: R });
  assert.deepEqual(c.sql.map((x) => x.text), [M.SQL.begin, M.SQL.identity, M.SQL.claims, M.SQL.rollback]);
  assert.deepEqual(c.sql[2].params, [606998, "2026-12-14", "2026-12-17"]);
  assert.equal(c.ended, true);
  for (const s of Object.values(M.SQL)) assert.doesNotMatch(s, /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|CALL|DO|COPY|TRUNCATE|ALTER|CREATE|DROP|GRANT|SET\s+(?!TRANSACTION))\b/i);
  assert.match(M.SQL.claims, /listing_id = \$1 AND released_at IS NULL AND stay && daterange\(\$2::date, \$3::date, '\[\)'\)/);
  assert.doesNotMatch(M.SQL.claims.split(" FROM ")[0], /\bid\b|intent|kind|claimed_at|release/, "only lower / upper(stay) leave the database");
  assert.deepEqual(r, { ok: true, code: "CLAIMS_READ", nights: { "2026-12-14": false, "2026-12-15": true, "2026-12-16": false } });
});

test("D2 DB guards fail closed: wrong role, not read-only, not the TEST instance (no claims query), connect / query errors → SQLSTATE only, always ROLLBACK", async () => {
  const R = range("2026-12-14", "2026-12-15");
  for (const [identity, code] of [[{ cu: "postgres", ro: "on", n: 1, env: "test" }, "ROLE_MISMATCH"], [{ cu: "mv_booking_app_dev", ro: "off", n: 1, env: "test" }, "NOT_READ_ONLY"],
    [{ cu: "mv_booking_app_dev", ro: "on", n: 1, env: "production" }, "NOT_TEST_INSTANCE"], [{ cu: "mv_booking_app_dev", ro: "on", n: 2, env: "test" }, "NOT_TEST_INSTANCE"]]) {
    const c = fakeClient({ identity }); const r = await M.readClaims({ client: c, range: R });
    assert.deepEqual(r, { ok: false, code }); assert.ok(!c.sql.some((x) => x.text === M.SQL.claims), `${code}: no claims read`);
    assert.equal(c.sql.at(-1).text, M.SQL.rollback);
  }
  const q = fakeClient({ failOn: "SELECT lower" }); const rq = await M.readClaims({ client: q, range: R });
  assert.deepEqual(rq, { ok: false, code: "QUERY_42P01" }); assert.equal(q.sql.at(-1).text, M.SQL.rollback);
  const cc = fakeClient({ connectError: Object.assign(new Error("password authentication failed for user x"), { code: "28P01" }) });
  assert.deepEqual(await M.readClaims({ client: cc, range: R }), { ok: false, code: "CONNECT_28P01" });
});

test("D3 half-open overlap: a claim [a, b) covers nights a … b-1 only; the check-out day is free; malformed / inclusive / empty ranges fail closed", () => {
  const nights = ["2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17"];
  const row = (f, t, li = true, ui = false) => ({ f, t, li, ui });
  assert.deepEqual(M.nightConflicts([row("2026-12-15", "2026-12-16")], nights).nights, { "2026-12-14": false, "2026-12-15": true, "2026-12-16": false, "2026-12-17": false });
  assert.deepEqual(M.nightConflicts([row("2026-12-10", "2026-12-15"), row("2026-12-17", "2026-12-20")], nights).nights,
    { "2026-12-14": true, "2026-12-15": false, "2026-12-16": false, "2026-12-17": true }, "a claim ending on the 15th frees the 15th; one starting on the 17th blocks it");
  assert.deepEqual(M.nightConflicts([], nights).nights, { "2026-12-14": false, "2026-12-15": false, "2026-12-16": false, "2026-12-17": false });
  for (const bad of [[row(null, "2026-12-16")], [row("2026-12-15", null)], [row("2026-12-15", "2026-12-16", true, true)], [row("2026-12-15", "2026-12-16", false, false)],
    [row("2026-12-16", "2026-12-16")], [row("2026-12-17", "2026-12-15")], ["x"]]) assert.deepEqual(M.nightConflicts(bad, nights), { ok: false, code: "CLAIM_RANGE_MALFORMED" });
  assert.equal(M.dbTarget("postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres").ok, true);
  for (const u of ["postgresql://other.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@evil.example:6543/postgres", "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=disable",
    "postgresql://mv_booking_app_dev.mxotevtiscernhqilyiu@aws-0-us-east-1.pooler.supabase.com:6543/postgres", "not a url"]) assert.equal(M.dbTarget(u).ok, false, u);
});

test("C1 combine fails closed: CLEAR only when Hostaway available AND no claim; unknown on either side → UNKNOWN; a failed read → every night UNKNOWN", () => {
  const R = range("2026-12-14", "2026-12-18");
  const h = { ok: true, nights: { "2026-12-14": "available", "2026-12-15": "available", "2026-12-16": "blocked", "2026-12-17": "unknown" } };
  const c = { ok: true, nights: { "2026-12-14": false, "2026-12-15": true, "2026-12-16": false, "2026-12-17": false } };
  const v = M.combine(R, h, c);
  assert.deepEqual(v.lines, [
    "night=2026-12-14 hostaway=available internal_claim=false verdict=CLEAR", "night=2026-12-15 hostaway=available internal_claim=true verdict=NOT_CLEAR",
    "night=2026-12-16 hostaway=blocked internal_claim=false verdict=NOT_CLEAR", "night=2026-12-17 hostaway=unknown internal_claim=false verdict=UNKNOWN"]);
  assert.equal(v.overall, "UNKNOWN"); assert.equal(v.exitCode, 3);
  const all = M.combine(range("2026-12-14", "2026-12-15"), { ok: true, nights: { "2026-12-14": "available" } }, { ok: true, nights: { "2026-12-14": false } });
  assert.deepEqual([all.overall, all.exitCode], ["ALL_CLEAR", 0]);
  const none = M.combine(range("2026-12-14", "2026-12-15"), { ok: true, nights: { "2026-12-14": "blocked" } }, { ok: true, nights: { "2026-12-14": false } });
  assert.deepEqual([none.overall, none.exitCode], ["NONE_CLEAR", 0]);
  const failed = M.combine(R, { ok: false, code: "HTTP_4XX" }, c);
  assert.ok(failed.lines.every((l) => l.endsWith("verdict=UNKNOWN"))); assert.equal(failed.overall, "UNKNOWN");
});

test("O1 CLI end to end (fakes via files): sanitized output, mismatched / missing results and bad inputs fail; no token, URL, note, guest or id is printed", () => {
  const dir = mkdtempSync(join(tmpdir(), "c123-"));
  try {
    const H = join(dir, "h.json"); const C = join(dir, "c.json");
    writeFileSync(H, JSON.stringify({ kind: "hostaway", checkIn: "2026-12-20", checkOut: "2026-12-22", ok: true, code: "CALENDAR_READ", http: 200,
      nights: { "2026-12-20": "available", "2026-12-21": "available" }, note: "PRIVATE NOTE", guest: "Jane Guest" }));
    writeFileSync(C, JSON.stringify({ kind: "claims", checkIn: "2026-12-20", checkOut: "2026-12-22", ok: true, code: "CLAIMS_READ",
      nights: { "2026-12-20": false, "2026-12-21": true }, intent: "11111111-2222-3333-4444-555555555555" }));
    const run = (mode, env) => spawnSync(process.execPath, [join(ROOT, SCRIPT), mode], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
    const ok = run("combine", { E7_CHECK_IN: "2026-12-20", E7_CHECK_OUT: "2026-12-22", E7_HOSTAWAY_RESULT: H, E7_CLAIMS_RESULT: C });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /night=2026-12-20 hostaway=available internal_claim=false verdict=CLEAR/);
    assert.match(ok.stdout, /night=2026-12-21 hostaway=available internal_claim=true verdict=NOT_CLEAR/);
    assert.match(ok.stdout, /RESULT overall=SOME_CLEAR clear=1 unknown=0/);
    assert.doesNotMatch(ok.stdout, /PRIVATE|Jane|11111111|Bearer|tok_/);
    const mism = run("combine", { E7_CHECK_IN: "2026-12-20", E7_CHECK_OUT: "2026-12-23", E7_HOSTAWAY_RESULT: H, E7_CLAIMS_RESULT: C });
    assert.equal(mism.status, 3); assert.match(mism.stdout, /hostaway=FAIL:RESULT_MISMATCH claims=FAIL:RESULT_MISMATCH/); assert.match(mism.stdout, /overall=UNKNOWN/);
    const missing = run("combine", { E7_CHECK_IN: "2026-12-20", E7_CHECK_OUT: "2026-12-22", E7_HOSTAWAY_RESULT: join(dir, "nope"), E7_CLAIMS_RESULT: C });
    assert.equal(missing.status, 3); assert.match(missing.stdout, /hostaway=FAIL:RESULT_MISSING/);
    const badIn = run("hostaway", { E7_CHECK_IN: "2026-12-20$(id)", E7_CHECK_OUT: "2026-12-22", E7_HOSTAWAY_TOKEN: TOKEN, E7_OUT_FILE: join(dir, "x") });
    assert.equal(badIn.status, 3); assert.match(badIn.stdout, /FAIL mode=hostaway code=CHECK_IN_INVALID/); assert.doesNotMatch(badIn.stdout, /tok_/);
    const badDb = run("claims", { E7_CHECK_IN: "2026-12-20", E7_CHECK_OUT: "2026-12-22", E7_OUT_FILE: join(dir, "d.json"),
      E7_DEV_BOOKING_DATABASE_URL: "postgresql://u:SECRETPW@evil.example:5432/postgres" });
    assert.equal(badDb.status, 3); assert.match(badDb.stdout, /FAIL mode=claims code=TARGET_SHAPE/); assert.doesNotMatch(badDb.stdout + readFileSync(join(dir, "d.json"), "utf8"), /SECRETPW|evil/);
    assert.equal(run("dispatch", { E7_CHECK_IN: "2026-12-20", E7_CHECK_OUT: "2026-12-22" }).status, 3, "unknown mode refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S1 script static boundary: Node built-ins only (pg from the pinned tooling), GET is the only method, no other host / endpoint, listing never from env", () => {
  const full = readFileSync(join(ROOT, SCRIPT), "utf8");
  const s = full.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/\/ [^\n]*/g, ""); // code only, comments stripped
  const imports = [...s.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:crypto", "node:fs", "node:https", "node:module", "node:url"]);
  assert.doesNotMatch(s, /import\(|require\("(?!pg")/);
  assert.deepEqual([...s.matchAll(/method: "([A-Z]+)"/g)].map((m) => m[1]), ["GET"]);
  assert.doesNotMatch(s, /\b(POST|PUT|PATCH|DELETE)\b/);
  assert.deepEqual([...new Set([...s.matchAll(/"([a-z0-9.-]+\.(?:com|net|io))"/g)].map((m) => m[1]))].sort(), ["api.hostaway.com", "aws-0-us-east-1.pooler.supabase.com"]);
  assert.doesNotMatch(s, /accessTokens|includeResources|reservations\b(?!\[)|\/v1\/(?!listings\/)/, "no token mint, no resources, no other endpoint");
  assert.doesNotMatch(s, /env\.[A-Z0-9_]*LISTING/, "listing is never caller-controlled");
  assert.doesNotMatch(s, /dispatches|workflow_dispatch|api\.github\.com/, "no workflow dispatch");
});

test("W1 workflow contract: workflow_dispatch only (2 date inputs), main only, contents:read, the existing environment once, each secret in its own step only, inputs via env only", () => {
  const t = readFileSync(join(ROOT, WF), "utf8");
  assert.match(t, /\non:\n  workflow_dispatch:\n    inputs:\n      check_in:\n[\s\S]*?\n      check_out:\n[\s\S]*?\n\npermissions:\n  contents: read\n/);
  assert.doesNotMatch(t, /\n  (schedule|push|pull_request|pull_request_target|repository_dispatch|workflow_call|workflow_run):/);
  assert.deepEqual(t.match(/environment: [a-z0-9-]+/g), ["environment: e7-test-auto"]);
  assert.match(t, /\n  check:\n    if: github\.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-24\.04\n    environment: e7-test-auto\n/);
  assert.deepEqual(t.match(/secrets\.[A-Z0-9_]+/g), ["secrets.E7_HOSTAWAY_TOKEN", "secrets.E7_DEV_BOOKING_DATABASE_URL"]);
  assert.doesNotMatch(t, /vars\.|github\.token|GITHUB_TOKEN|actions: write|contents: write|id-token|gh workflow|dispatches|E7_STRIPE|E7_RESEND|E7_DISPATCH|E7_TEST_AUTO_ARMED/);
  const steps = t.split("\n      - name: ").slice(1);
  const withSecret = steps.filter((s) => /secrets\./.test(s));
  assert.equal(withSecret.length, 2);
  assert.match(withSecret[0], /E7_HOSTAWAY_TOKEN: \$\{\{ secrets\.E7_HOSTAWAY_TOKEN \}\}\n        run: node wrapper\/scripts\/e7-test-auto-availability-check\.mjs hostaway 2>\/dev\/null(\n|$)/);
  assert.match(withSecret[1], /E7_DEV_BOOKING_DATABASE_URL: \$\{\{ secrets\.E7_DEV_BOOKING_DATABASE_URL \}\}\n        run: node wrapper\/scripts\/e7-test-auto-availability-check\.mjs claims 2>\/dev\/null(\n|$)/);
  for (const s of steps) { const run = s.split("\n        run:")[1] ?? ""; assert.doesNotMatch(run, /\$\{\{/, "no expression inside a run script (inputs reach the script via env only)"); }
  assert.equal((t.match(/persist-credentials: false/g) || []).length, 2);
  assert.match(t, /ref: bbf12aa22446807df7b63a55e38a464f4be88763/);
  assert.match(t, /\n      - name: Combine \(no secret[^\n]*\n        env:\n(?:          E7_[A-Z_]+: [^\n]+\n)+        run: node wrapper\/scripts\/e7-test-auto-availability-check\.mjs combine 2>\/dev\/null\n/);
  assert.doesNotMatch(steps.at(-1), /continue-on-error/, "the combine step decides the run result");
});
