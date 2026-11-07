// test/e7-connected-native-endpoint-policy.test.mjs — root de6285b5 B (contract claude/e7-native-endpoint-policy.md): pure P1/P2 endpoint policy
// matrix and the P3 lock pre-check's bounding / disposal against FAKE pools (no network, no DB). The real-PG mapping proofs live in
// test/db/e7-run-r1-native-execute.test.mjs (E7 / E8).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as L from "../scripts/e7-connected/run-r1-launcher.mjs";
import { LOCK_KEY } from "../scripts/e7-connected/run-core.mjs";

const CANARY = "CANARYpw7f3e9Q";
const DH = "db.mxotevtiscernhqilyiu.supabase.co"; const P = "aws-0-us-east-1.pooler.supabase.com"; const SUF = ".mxotevtiscernhqilyiu";
const login = (url) => { const l = Object.create(null); Object.defineProperty(l, "connectionString", { value: url.replace("PW", CANARY), enumerable: false }); return l; };
const pair = (a, r) => ({ app: login(a), report: login(r) });
const both = (h, ua, ur, rest = ":5432/postgres") => pair(`postgresql://${ua}:PW@${h}${rest}`, `postgresql://${ur}:PW@${h}${rest}`);

test("P2 endpoint matrix: ONLY exact DEV direct (plain role) or exact DEV session pooler (role + project suffix), same mode both slots; everything else ENDPOINT_MODE_REFUSED; no URL text in any result", () => {
  const ok = [
    ["direct", both(DH, "mv_booking_app_dev", "mv_booking_report_dev"), "direct"],
    ["direct postgres: scheme", pair(`postgres://u_app:PW@${DH}:5432/postgres`, `postgres://u_rep:PW@${DH}:5432/postgres`), "direct"],
    ["session pooler", both(P, `mv_booking_app_dev${SUF}`, `mv_booking_report_dev${SUF}`), "session-pooler"]
  ];
  for (const [label, logins, mode] of ok) assert.deepEqual(L.checkEndpointPolicy(logins), { ok: true, mode }, label);
  const bad = [
    ["pooler 6543", both(P, `u${SUF}`, `v${SUF}`, ":6543/postgres")], ["direct 6543", both(DH, "u", "v", ":6543/postgres")],
    ["6432", both(P, `u${SUF}`, `v${SUF}`, ":6432/postgres")], ["default port (none)", both(DH, "u", "v", "/postgres")], ["port 5433", both(DH, "u", "v", ":5433/postgres")],
    ["other project", both("db.aaaaaaaaaaaaaaaaaaaa.supabase.co", "u", "v")], ["host prefix trick", both(`${DH}.evil.example`, "u", "v")],
    ["host suffix trick", both(`x${DH}`, "u", "v")], ["uppercase host (opaque, not case-folded)", both(DH.toUpperCase(), "u", "v")], ["other region", both("aws-0-eu-west-1.pooler.supabase.com", `u${SUF}`, `v${SUF}`)],
    ["aws-1 pooler", both("aws-1-us-east-1.pooler.supabase.com", `u${SUF}`, `v${SUF}`)],
    ["IPv4 literal", both("10.1.2.3", "u", "v")], ["IPv6 literal", both("[2600:1f18::1]", "u", "v")],
    ["loopback IPv4 no seam", both("127.0.0.1", "u", "v")], ["localhost no seam", both("localhost", "u", "v")], ["loopback IPv6 no seam", both("[::1]", "u", "v")],
    ["pooler missing suffix", both(P, "u", "v")], ["pooler wrong suffix", both(P, "u.aaaaaaaaaaaaaaaaaaaa", "v.aaaaaaaaaaaaaaaaaaaa")],
    ["pooler bare suffix", both(P, SUF, SUF)], ["pooler double suffix", both(P, `u${SUF}${SUF}`, `v${SUF}${SUF}`)],
    ["pooler one slot missing suffix", pair(`postgresql://u${SUF}:PW@${P}:5432/postgres`, `postgresql://v:PW@${P}:5432/postgres`)],
    ["suffix on direct", both(DH, `u${SUF}`, `v${SUF}`)], ["uppercase role", both(DH, "U_APP", "U_REP")], ["encoded role", both(DH, "u%2Dx", "v")],
    ["other database", both(DH, "u", "v", ":5432/booking")], ["empty database", both(DH, "u", "v", ":5432/")], ["nested path", both(DH, "u", "v", ":5432/postgres/x")],
    ["mixed direct / pooler", pair(`postgresql://u:PW@${DH}:5432/postgres`, `postgresql://v${SUF}:PW@${P}:5432/postgres`)],
    ["mixed ports", pair(`postgresql://u:PW@${DH}:5432/postgres`, `postgresql://v:PW@${DH}:6543/postgres`)],
    ["other scheme", pair(`mysql://u:PW@${DH}:5432/postgres`, `mysql://v:PW@${DH}:5432/postgres`)], ["unparsable", pair("not a url PW", "x")]
  ];
  for (const [label, logins] of bad) {
    const r = L.checkEndpointPolicy(logins);
    assert.deepEqual(r, { ok: false, code: "ENDPOINT_MODE_REFUSED" }, label);
    assert.ok(!JSON.stringify(r).includes(CANARY));
  }
  assert.deepEqual(L.checkEndpointPolicy(null), { ok: false, code: "ENDPOINT_MODE_REFUSED" }, "malformed input fails closed");
  // the in-process seam admits LOOPBACK only (same host / port / db both slots); it never widens remote hosts
  const lb = { loopbackForTests: true };
  assert.deepEqual(L.checkEndpointPolicy(both("127.0.0.1", "test_app", "test_report", ":54321/postgres"), lb), { ok: true, mode: "loopback-test" });
  assert.deepEqual(L.checkEndpointPolicy(both("[::1]", "u", "v", ":54321/x"), lb), { ok: true, mode: "loopback-test" });
  for (const [label, logins] of [["other host", both("10.1.2.3", "u", "v")], ["6543 pooler", both(P, `u${SUF}`, `v${SUF}`, ":6543/postgres")],
    ["mixed loopback ports", pair("postgresql://u:PW@127.0.0.1:1/postgres", "postgresql://v:PW@127.0.0.1:2/postgres")],
    ["mixed loopback / direct", pair("postgresql://u:PW@127.0.0.1:5432/postgres", `postgresql://v:PW@${DH}:5432/postgres`)]])
    assert.deepEqual(L.checkEndpointPolicy(logins, lb), { ok: false, code: "ENDPOINT_MODE_REFUSED" }, `seam: ${label}`);
  assert.deepEqual(L.checkEndpointPolicy(both("127.0.0.1", "u", "v"), { loopbackForTests: "true" }), { ok: false, code: "ENDPOINT_MODE_REFUSED" }, "seam needs boolean true");
  assert.deepEqual(Object.keys(L.ENDPOINTS), ["direct", "session-pooler"]); assert.ok(Object.isFrozen(L.ENDPOINTS) && Object.isFrozen(L.ENDPOINTS.direct));
});

// ---- P3 fakes ----------------------------------------------------------------------------------------------------------------------
function fakeProc() {
  let id = 0; const live = new Map();
  return { live, setTimer: (fn, ms) => { const k = ++id; live.set(k, setTimeout(() => { live.delete(k); fn(); }, ms)); return k; },
    clearTimer: (k) => { clearTimeout(live.get(k)); live.delete(k); } };
}
function fakeClient(queryImpl) {
  const c = new EventEmitter(); c.queries = []; c.releases = [];
  c.query = (sql, params) => { c.queries.push({ sql, params }); return queryImpl(sql, params); };
  c.release = (destroy) => { c.releases.push(destroy); };
  return c;
}
const fakePool = (connectImpl) => { const p = { connects: 0 }; p.connect = () => { p.connects += 1; return connectImpl(); }; return p; };
const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const K = 100;                                                       // 10 s connect / 5 s query bounds become 100 ms / 50 ms

test("P3 lockPrecheck exact statement + outcomes: n=0 → CLEAR; n>0 → RUN_LOCK_PRESENT_BEFORE_START; malformed rows → UNAVAILABLE; exactly ONE statement, client destroyed exactly once, no timer left", async () => {
  assert.equal(L.LOCK_PRECHECK_SQL, "SELECT count(*)::int AS n FROM pg_catalog.pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AND l.classid = ((pg_catalog.hashtext($1)::bigint + 4294967296) % 4294967296)::oid AND l.objid = 0::oid AND l.objsubid = 2");
  assert.ok(!/pg_advisory_unlock|pg_terminate|pg_cancel|pg_try_advisory|pg_advisory_lock|INSERT|UPDATE|DELETE/i.test(L.LOCK_PRECHECK_SQL), "read-only: never unlock / terminate / acquire");
  const cases = [
    [{ rows: [{ n: 0 }] }, "LOCK_PRECHECK_CLEAR"], [{ rows: [{ n: 1 }] }, "RUN_LOCK_PRESENT_BEFORE_START"], [{ rows: [{ n: 3 }] }, "RUN_LOCK_PRESENT_BEFORE_START"],
    [{ rows: [] }, "LOCK_PRECHECK_UNAVAILABLE"], [{ rows: [{ n: 0 }, { n: 0 }] }, "LOCK_PRECHECK_UNAVAILABLE"], [{ rows: [{ n: "0" }] }, "LOCK_PRECHECK_UNAVAILABLE"],
    [{ rows: [{ n: -1 }] }, "LOCK_PRECHECK_UNAVAILABLE"], [{ rows: [{ n: 0.5 }] }, "LOCK_PRECHECK_UNAVAILABLE"], [{ rows: [{}] }, "LOCK_PRECHECK_UNAVAILABLE"],
    [{ rows: [null] }, "LOCK_PRECHECK_UNAVAILABLE"], [{}, "LOCK_PRECHECK_UNAVAILABLE"], [null, "LOCK_PRECHECK_UNAVAILABLE"]
  ];
  for (const [res, want] of cases) {
    const proc = fakeProc(); const c = fakeClient(async () => res); const pool = fakePool(async () => c);
    const r = await L.lockPrecheck(pool, { proc, K });
    assert.deepEqual(r, { code: want }, JSON.stringify(res));
    assert.deepEqual([pool.connects, c.queries.length, c.releases], [1, 1, [true]]);
    assert.deepEqual(c.queries[0], { sql: L.LOCK_PRECHECK_SQL, params: [LOCK_KEY] });
    assert.equal(proc.live.size, 0, "no timer left armed"); assert.equal(c.listenerCount("error"), 0, "error listener removed");
  }
});

test("P3 lockPrecheck bounding / disposal: connect hang / reject / throw / late arrival; query hang / reject / throw / late result; client 'error' while held; never any SQL after a failed connect", async () => {
  { const proc = fakeProc(); const pool = fakePool(never); const r = await L.lockPrecheck(pool, { proc, K }); assert.deepEqual(r, { code: "LOCK_PRECHECK_UNAVAILABLE" }, "connect hang → bounded"); assert.equal(proc.live.size, 0); }
  { const proc = fakeProc(); const pool = fakePool(async () => { throw new Error(`connect ${CANARY}`); }); const r = await L.lockPrecheck(pool, { proc, K });
    assert.deepEqual(r, { code: "LOCK_PRECHECK_UNAVAILABLE" }); assert.ok(!JSON.stringify(r).includes(CANARY), "no error echo"); }
  { const proc = fakeProc(); const pool = { connect: () => { throw new Error("sync"); } }; assert.deepEqual(await L.lockPrecheck(pool, { proc, K }), { code: "LOCK_PRECHECK_UNAVAILABLE" }); }
  { // late client after the connect bound: destroyed on arrival, never queried
    const proc = fakeProc(); const c = fakeClient(async () => ({ rows: [{ n: 0 }] }));
    const pool = fakePool(() => sleep(250).then(() => c));
    const r = await L.lockPrecheck(pool, { proc, K }); assert.deepEqual(r, { code: "LOCK_PRECHECK_UNAVAILABLE" });
    await sleep(300); assert.deepEqual([c.queries.length, c.releases], [0, [true]], "late client destroyed exactly once, no SQL"); }
  { const proc = fakeProc(); const c = fakeClient(never); const r = await L.lockPrecheck(fakePool(async () => c), { proc, K });
    assert.deepEqual([r.code, c.queries.length, c.releases], ["LOCK_PRECHECK_UNAVAILABLE", 1, [true]], "query hang → bounded, destroyed"); assert.equal(proc.live.size, 0); }
  { const c = fakeClient(async () => { throw new Error(`q ${CANARY}`); }); const r = await L.lockPrecheck(fakePool(async () => c), { proc: fakeProc(), K });
    assert.deepEqual([r.code, c.releases], ["LOCK_PRECHECK_UNAVAILABLE", [true]]); }
  { const c = fakeClient(() => { throw new Error("sync q"); }); const r = await L.lockPrecheck(fakePool(async () => c), { proc: fakeProc(), K });
    assert.deepEqual([r.code, c.releases], ["LOCK_PRECHECK_UNAVAILABLE", [true]]); }
  { // a late query result after the query bound is ignored (no second release, outcome unchanged)
    const c = fakeClient(() => sleep(200).then(() => ({ rows: [{ n: 0 }] }))); const r = await L.lockPrecheck(fakePool(async () => c), { proc: fakeProc(), K });
    await sleep(250); assert.deepEqual([r.code, c.releases], ["LOCK_PRECHECK_UNAVAILABLE", [true]]); }
  { // a client 'error' while held does not crash the process (listener attached), outcome decided by the query
    const c = fakeClient(async () => { c.emit("error", new Error("backend gone")); throw new Error("x"); });
    const r = await L.lockPrecheck(fakePool(async () => c), { proc: fakeProc(), K }); assert.deepEqual([r.code, c.releases], ["LOCK_PRECHECK_UNAVAILABLE", [true]]); }
});

test("P3 lockPrecheck interruption: aborted before connect → no connect; aborted during connect → late client destroyed, no SQL; aborted during query → destroyed once; aborted between connect and query → no SQL", async () => {
  { const ac = new AbortController(); ac.abort(); const pool = fakePool(async () => fakeClient(async () => ({ rows: [{ n: 0 }] })));
    assert.deepEqual(await L.lockPrecheck(pool, { proc: fakeProc(), K, signal: ac.signal }), { code: "LOCK_PRECHECK_INTERRUPTED" }); assert.equal(pool.connects, 0); }
  { const ac = new AbortController(); const c = fakeClient(async () => ({ rows: [{ n: 0 }] }));
    const pool = fakePool(() => sleep(60).then(() => c)); const p = L.lockPrecheck(pool, { proc: fakeProc(), K: 1, signal: ac.signal });
    setTimeout(() => ac.abort(), 10); assert.deepEqual(await p, { code: "LOCK_PRECHECK_INTERRUPTED" }); await sleep(100);
    assert.deepEqual([c.queries.length, c.releases], [0, [true]]); }
  { const ac = new AbortController(); const c = fakeClient(never); const proc = fakeProc();
    const p = L.lockPrecheck(fakePool(async () => c), { proc, K: 1, signal: ac.signal }); setTimeout(() => ac.abort(), 20);
    assert.deepEqual(await p, { code: "LOCK_PRECHECK_INTERRUPTED" }); assert.deepEqual([c.queries.length, c.releases], [1, [true]]); assert.equal(proc.live.size, 0); }
  { const ac = new AbortController(); const c = fakeClient(async () => ({ rows: [{ n: 0 }] }));
    const pool = fakePool(async () => { ac.abort(); return c; });                // abort lands while the connect is settling
    assert.deepEqual(await L.lockPrecheck(pool, { proc: fakeProc(), K, signal: ac.signal }), { code: "LOCK_PRECHECK_INTERRUPTED" });
    assert.deepEqual([c.queries.length, c.releases], [0, [true]], "no SQL after an interrupted connect"); }
});
