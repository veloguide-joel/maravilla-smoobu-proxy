// T1b (root ruling, V1): scoped acquired-client end OBSERVATION in the native launcher. Synthetic pools / clients only: no DB, owner file,
// provider or network. Includes the REAL pinned pg-pool (via pg.Pool) with a synthetic Client to cover failed / pending acquisitions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import { observeAcquiredClients, endAll, ACQUIRED_CLIENT_END_SCOPE, ACQUIRED_CLIENT_END_STATUS, POOL_END_BOUND_MS } from "../scripts/e7-connected/run-r1-launcher.mjs";

const KEYS = ["acquired", "endObserved", "scope", "status"];
function check(snap, want) {
  assert.ok(Object.isFrozen(snap), "snapshot frozen");
  assert.deepEqual(Object.keys(snap).sort(), KEYS);
  assert.equal(snap.scope, ACQUIRED_CLIENT_END_SCOPE);
  assert.ok(ACQUIRED_CLIENT_END_STATUS.includes(snap.status));
  for (const [k, v] of Object.entries(want)) assert.equal(snap[k], v, k);
}
const fakePool = () => new EventEmitter();
const fakeClient = () => new EventEmitter();
function ctlProc() {
  const timers = []; let armed = 0; let cleared = 0;
  return { proc: { setTimer(fn, ms) { armed++; const t = { fn, ms, live: true }; timers.push(t); return t; }, clearTimer(t) { cleared++; if (t) t.live = false; } },
    fire() { for (const t of timers) if (t.live) { t.live = false; t.fn(); } }, stats: () => ({ armed, cleared, ms: timers.map((t) => t.ms) }) };
}
const tick = () => new Promise((r) => setImmediate(r));

test("T1b zero acquisitions → NONE_ACQUIRED (vacuous), counts 0; no 'error' listener ever added", () => {
  const p = fakePool(); const o = observeAcquiredClients(p);
  assert.equal(p.listenerCount("connect"), 1); assert.equal(p.listenerCount("error"), 0);
  check(o.settle(), { acquired: 0, endObserved: 0, status: "NONE_ACQUIRED" });
  assert.equal(p.listenerCount("connect"), 0, "own connect listener removed at settlement");
});

test("T1b end BEFORE settlement → ALL_ACQUIRED_END_OBSERVED; end AFTER settlement → SOME_…; snapshot immutable and identical after late events", () => {
  let p = fakePool(); let o = observeAcquiredClients(p); const a = fakeClient(); const b = fakeClient();
  p.emit("connect", a); p.emit("connect", b); a.emit("end"); b.emit("end");
  check(o.settle(), { acquired: 2, endObserved: 2, status: "ALL_ACQUIRED_END_OBSERVED" });
  p = fakePool(); o = observeAcquiredClients(p); const c = fakeClient(); const d = fakeClient();
  p.emit("connect", c); p.emit("connect", d); c.emit("end");
  const s1 = o.settle();
  check(s1, { acquired: 2, endObserved: 1, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  d.emit("end"); p.emit("connect", fakeClient());                     // late events
  const s2 = o.settle();
  assert.equal(s2, s1, "same frozen object"); check(s2, { acquired: 2, endObserved: 1, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  assert.equal(c.listenerCount("end"), 0); assert.equal(d.listenerCount("end"), 0);
});

test("T1b acquired reuse / duplicate connect emit → counted once; foreign listeners preserved at cleanup; no error listener on clients", () => {
  const p = fakePool(); const foreign = () => {}; p.on("connect", foreign);
  const o = observeAcquiredClients(p); const a = fakeClient(); const fe = () => {}; a.on("end", fe);
  p.emit("connect", a); p.emit("connect", a); p.emit("connect", null); p.emit("connect", 7);
  assert.equal(a.listenerCount("end"), 2); assert.equal(a.listenerCount("error"), 0);
  check(o.settle(), { acquired: 1, endObserved: 0, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  assert.deepEqual(p.listeners("connect"), [foreign], "only the observer's own connect listener removed");
  assert.deepEqual(a.listeners("end"), [fe], "only the observer's own end marker removed");
});

test("T1b instrumentation faults → NOT_OBSERVED (null counts); settle never throws; caller path unaffected", () => {
  const cases = [
    () => { const p = fakePool(); p.on = () => { throw new Error("attach"); }; return { p }; },
    () => { const p = fakePool(); const o = observeAcquiredClients(p); const c = fakeClient(); c.once = () => { throw new Error("once"); }; p.emit("connect", c); return { o }; },
    () => { const p = fakePool(); const o = observeAcquiredClients(p); p.removeListener = () => { throw new Error("detach"); }; return { o }; },
    () => { const p = fakePool(); const o = observeAcquiredClients(p); const c = fakeClient(); p.emit("connect", c); c.removeListener = () => { throw new Error("detach-c"); }; return { o }; }
  ];
  for (const mk of cases) {
    const r = mk(); const o = r.o ?? observeAcquiredClients(r.p);
    let snap; assert.doesNotThrow(() => { snap = o.settle(); });
    check(snap, { acquired: null, endObserved: null, status: "NOT_OBSERVED" });
  }
});

test("T1b endAll: dispositions / single end call / same bound timer UNCHANGED; snapshot frozen at EACH settlement incl. rejection and timeout", async () => {
  const mk = (endImpl) => { const p = fakePool(); p.calls = 0; p.end = () => { p.calls++; return endImpl(p); }; return p; };
  const c1 = fakeClient(); const c2 = fakeClient();
  const app = mk((p) => { c1.emit("end"); return Promise.resolve(); });            // client end before logical settle
  const report = mk(() => Promise.reject(new Error("end failed")));               // rejection
  const obs = { app: observeAcquiredClients(app), report: observeAcquiredClients(report) };
  app.emit("connect", c1); report.emit("connect", c2);
  const ctl = ctlProc(); const ace = {};
  const out = await endAll({ app, report }, ctl.proc, obs, ace);
  assert.deepEqual(out, { app: "ended", report: "end_failed" }, "teardown.pools shape and values unchanged");
  assert.equal(app.calls, 1); assert.equal(report.calls, 1);
  assert.deepEqual(ctl.stats(), { armed: 2, cleared: 2, ms: [POOL_END_BOUND_MS, POOL_END_BOUND_MS] }, "same one bound per slot, cleared on settle; no new timer");
  check(ace.app, { acquired: 1, endObserved: 1, status: "ALL_ACQUIRED_END_OBSERVED" });
  check(ace.report, { acquired: 1, endObserved: 0, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  c2.emit("end"); assert.equal(ace.report.endObserved, 0, "late end does not mutate");
  // timeout: end never settles → the existing bound fires → "unknown"; snapshot taken at THAT settlement; a later end changes nothing
  const ctl2 = ctlProc(); const c3 = fakeClient(); let lateResolve;
  const hang = mk(() => new Promise((r) => { lateResolve = r; }));
  const o3 = { report: observeAcquiredClients(hang) }; hang.emit("connect", c3); const ace2 = {};
  const pr = endAll({ report: hang }, ctl2.proc, o3, ace2);
  await tick(); ctl2.fire();
  assert.deepEqual(await pr, { report: "unknown" });
  check(ace2.report, { acquired: 1, endObserved: 0, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  const frozen = ace2.report; c3.emit("end"); lateResolve(); await tick();
  assert.equal(ace2.report, frozen); assert.equal(frozen.endObserved, 0);
  // legacy call shape (no observers) still works and yields the same dispositions
  const ctl3 = ctlProc(); const plain = mk(() => Promise.resolve());
  assert.deepEqual(await endAll({ app: plain }, ctl3.proc), { app: "ended" });
});

test("T1b REAL pinned pg-pool with a synthetic Client: failed connect NOT counted (vacuous NONE_ACQUIRED); success counted; end-after-pool.end shows SOME_…", async () => {
  class FailClient extends EventEmitter { connect(cb) { setImmediate(() => cb(new Error("synthetic connect failure"))); } end(cb) { setImmediate(() => { this.emit("end"); cb && cb(); }); } }
  let pool = new pg.Pool({ Client: FailClient, max: 1 }); let o = observeAcquiredClients(pool);
  await assert.rejects(pool.connect(), /synthetic connect failure/, "original failure propagates unchanged");
  await pool.end();
  check(o.settle(), { acquired: 0, endObserved: 0, status: "NONE_ACQUIRED" });
  assert.equal(pool.listenerCount("error"), 0, "observer added no pool 'error' listener");
  // successful acquisition; client 'end' is delayed past pool.end() resolution (the accepted E2 enabling mechanism)
  class DelayedEndClient extends EventEmitter {
    connect(cb) { setImmediate(() => cb(null)); }
    query(_t, _v, cb) { const r = { rows: [{ n: 0 }] }; if (typeof cb === "function") { setImmediate(() => cb(null, r)); return undefined; } return Promise.resolve(r); }
    end(cb) { setTimeout(() => this.emit("end"), 30); if (cb) setImmediate(cb); return Promise.resolve(); }
  }
  pool = new pg.Pool({ Client: DelayedEndClient, max: 1 }); o = observeAcquiredClients(pool);
  const c = await pool.connect(); c.release(true);
  await pool.end();
  const s = o.settle();
  check(s, { acquired: 1, endObserved: 0, status: "SOME_ACQUIRED_END_UNOBSERVED" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(o.settle(), s); assert.equal(s.endObserved, 0, "late client end after settlement never mutates");
});
