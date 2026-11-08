// run-lock-precheck.test.mjs — focused regression for the Route-2 extraction (feature/e7-p3-lock-precheck).
// Proves: (1) the launcher re-exports the SAME function object (behaviour preserved, surface unchanged — LOCK_KEY still not exported);
// (2) the constants / SQL are intact and the SQL is a read-only pg_locks count with no lock-acquire / mutation / txn-control tokens;
// (3) the leaf LOCK_KEY matches run-core.mjs (drift guard, by reading run-core as TEXT — no executor import); (4) the four result codes,
// single statement with the exact (SQL,[LOCK_KEY]) params, exactly-once release(true), late-client disposal, and error/abort/timeout paths.
// It does NOT re-run the accepted runner suite. Fake pool + fake proc only; no DB, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lockPrecheck, LOCK_KEY, LOCK_PRECHECK_SQL, LOCK_PRECHECK_CONNECT_MS, LOCK_PRECHECK_QUERY_MS } from "./run-lock-precheck.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const noFireProc = () => ({ setTimer: () => ({}), clearTimer: () => {} });
const manualProc = () => { const pend = new Set(); return { setTimer: (fn) => { const id = { fn }; pend.add(id); return id; }, clearTimer: (id) => pend.delete(id), fire: () => { for (const id of [...pend]) { pend.delete(id); id.fn(); } } }; };
function fakeClient({ queryResult, queryReject = false, fireErrorOnAttach = false } = {}) {
  const calls = { query: [], release: [], errHandler: null };
  const c = {
    on: (ev, h) => { if (ev === "error") { calls.errHandler = h; if (fireErrorOnAttach) h(new Error("boom")); } },
    removeListener: () => {},
    query: (sql, params) => { calls.query.push({ sql, params }); return queryReject ? Promise.reject(new Error("q")) : Promise.resolve(queryResult); },
    release: (arg) => { calls.release.push(arg); }
  };
  return { c, calls };
}
const immediatePool = (c) => ({ connect: () => Promise.resolve(c) });

test("re-export identity: launcher binds the SAME leaf function and keeps its surface", async () => {
  const L = await import("./run-r1-launcher.mjs");
  assert.equal(L.lockPrecheck, lockPrecheck, "launcher.lockPrecheck must be the leaf function (behaviour preserved)");
  assert.equal(L.LOCK_PRECHECK_SQL, LOCK_PRECHECK_SQL);
  assert.equal(L.LOCK_PRECHECK_CONNECT_MS, LOCK_PRECHECK_CONNECT_MS);
  assert.equal(L.LOCK_PRECHECK_QUERY_MS, LOCK_PRECHECK_QUERY_MS);
  assert.equal("LOCK_KEY" in L, false, "launcher must NOT newly export LOCK_KEY (surface unchanged)");
});

test("constants + read-only SQL shape", () => {
  assert.equal(LOCK_KEY, "e7-connected-runner");
  assert.equal(LOCK_PRECHECK_CONNECT_MS, 10_000);
  assert.equal(LOCK_PRECHECK_QUERY_MS, 5_000);
  const expected = "SELECT count(*)::int AS n FROM pg_catalog.pg_locks l"
    + " WHERE l.locktype = 'advisory' AND l.granted"
    + " AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())"
    + " AND l.classid = ((pg_catalog.hashtext($1)::bigint + 4294967296) % 4294967296)::oid"
    + " AND l.objid = 0::oid AND l.objsubid = 2";
  assert.equal(LOCK_PRECHECK_SQL, expected);
  for (const bad of [/pg_try_advisory_lock/i, /pg_advisory_unlock/i, /pg_advisory_lock\b/i, /\binsert\b/i, /\bupdate\b/i, /\bdelete\b/i, /\bbegin\b/i, /\bcommit\b/i, /\bset\b/i, /\bgrant\b/i])
    assert.equal(bad.test(LOCK_PRECHECK_SQL), false, `SQL must not contain ${bad}`);
});

test("drift guard: run-core.mjs LOCK_KEY equals the leaf LOCK_KEY (text, no executor import)", () => {
  const src = readFileSync(join(HERE, "run-core.mjs"), "utf8");
  const m = src.match(/LOCK_KEY\s*=\s*"([^"]+)"/);
  assert.ok(m, "run-core.mjs must define LOCK_KEY");
  assert.equal(m[1], LOCK_KEY);
});

test("CLEAR: n=0 → exactly one (SQL,[LOCK_KEY]) query and one release(true)", async () => {
  const { c, calls } = fakeClient({ queryResult: { rows: [{ n: 0 }] } });
  const r = await lockPrecheck(immediatePool(c), { proc: noFireProc() });
  assert.equal(r.code, "LOCK_PRECHECK_CLEAR");
  assert.equal(calls.query.length, 1);
  assert.equal(calls.query[0].sql, LOCK_PRECHECK_SQL);
  assert.deepEqual(calls.query[0].params, [LOCK_KEY]);
  assert.deepEqual(calls.release, [true]);
});

test("PRESENT: n>0 → RUN_LOCK_PRESENT_BEFORE_START", async () => {
  const { c } = fakeClient({ queryResult: { rows: [{ n: 5 }] } });
  const r = await lockPrecheck(immediatePool(c), { proc: noFireProc() });
  assert.equal(r.code, "RUN_LOCK_PRESENT_BEFORE_START");
});

test("bad rows → UNAVAILABLE (never clears)", async () => {
  for (const rows of [[{ n: -1 }], [], [{ n: 1.5 }], [{}], [{ n: 0 }, { n: 0 }]]) {
    const { c } = fakeClient({ queryResult: { rows } });
    const r = await lockPrecheck(immediatePool(c), { proc: noFireProc() });
    assert.equal(r.code, "LOCK_PRECHECK_UNAVAILABLE", JSON.stringify(rows));
  }
});

test("connect rejection → UNAVAILABLE, no client, no query", async () => {
  let queried = false;
  const pool = { connect: () => Promise.reject(new Error("no")) };
  const r = await lockPrecheck(pool, { proc: noFireProc() });
  assert.equal(r.code, "LOCK_PRECHECK_UNAVAILABLE");
  assert.equal(queried, false);
});

test("query rejection → UNAVAILABLE with release(true) once", async () => {
  const { c, calls } = fakeClient({ queryReject: true });
  const r = await lockPrecheck(immediatePool(c), { proc: noFireProc() });
  assert.equal(r.code, "LOCK_PRECHECK_UNAVAILABLE");
  assert.deepEqual(calls.release, [true]);
  assert.equal(calls.query.length, 1);
});

test("observed client error vetoes clearance, disposes once, never queries", async () => {
  const { c, calls } = fakeClient({ queryResult: { rows: [{ n: 0 }] }, fireErrorOnAttach: true });
  const r = await lockPrecheck(immediatePool(c), { proc: noFireProc() });
  assert.equal(r.code, "LOCK_PRECHECK_UNAVAILABLE");
  assert.deepEqual(calls.release, [true]);
  assert.equal(calls.query.length, 0);
});

test("pre-aborted signal → INTERRUPTED, connect never called", async () => {
  let connectCalled = false;
  const pool = { connect: () => { connectCalled = true; return Promise.resolve(fakeClient().c); } };
  const ac = new AbortController(); ac.abort();
  const r = await lockPrecheck(pool, { proc: noFireProc(), signal: ac.signal });
  assert.equal(r.code, "LOCK_PRECHECK_INTERRUPTED");
  assert.equal(connectCalled, false);
});

test("connect timeout fires → UNAVAILABLE; late client disposed via release(true), never queried", async () => {
  let resolveConnect; const connectP = new Promise((res) => { resolveConnect = res; });
  const { c, calls } = fakeClient({ queryResult: { rows: [{ n: 0 }] } });
  const proc = manualProc();
  const pr = lockPrecheck({ connect: () => connectP }, { proc });
  proc.fire();                 // connect-bound timer fires before the client arrives
  resolveConnect(c);           // late arrival after the stop
  const r = await pr;
  assert.equal(r.code, "LOCK_PRECHECK_UNAVAILABLE");
  assert.deepEqual(calls.release, [true]);
  assert.equal(calls.query.length, 0);
});
