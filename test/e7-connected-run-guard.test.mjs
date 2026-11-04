// E7 connected-test runner SLICE B — run-guard unit tests (OFFLINE; injected fake monotonic / timers / clients / lock; no DB, no network,
// no real long sleeps; every pending-forever assertion is made after controlled fake progress).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateGuardDeps, createGuard, createLifecycle, createLedger, wrapExecutors, trackClient, isNativePromise, MAX_DELAY_MS,
  MAX_EARLY_FIRES, LIMITS } from "../scripts/e7-connected/run-guard.mjs";
import { ExecutorRefusal } from "../scripts/e7-connected/executor-adapters.mjs";

let netAttempts = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { netAttempts += 1; throw new Error("network refused (offline guard suite)"); };
let unhandled = 0;
const onUnhandled = () => { unhandled += 1; };
process.on("unhandledRejection", onUnhandled);
after(async () => {
  await new Promise((r) => setImmediate(r));
  globalThis.fetch = realFetch; process.off("unhandledRejection", onUnhandled);
  assert.equal(netAttempts, 0, "no network attempt");
  assert.equal(unhandled, 0, "no unhandled rejection leaked");
});

const flush = async (n = 30) => { for (let i = 0; i < n; i++) await null; };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const PENDING = Symbol("pending");
const stateOf = async (p) => { const v = await Promise.race([p.then((x) => ({ x }), (e) => ({ e })), flush(60).then(() => PENDING)]); return v; };

/** deterministic fake clock + timer source. `plan` lets a test replace the NEXT arm()'s behaviour. */
function fake(start = 0) {
  const f = { t: start, timers: [], armCalls: [], armThis: [], cancels: 0, plan: [], monoPlan: [], reads: 0 };
  f.monotonic = function () { f.reads += 1; const p = f.monoPlan.shift(); if (p) return p(); return f.t; };
  f.arm = function (...args) {
    f.armCalls.push(args); f.armThis.push(this);
    const p = f.plan.shift(); if (p) return p(args[0]);
    const d = deferred(); const e = { due: f.t + args[0], d, cancelled: false, fired: false };
    f.timers.push(e);
    return { promise: d.promise, cancel: () => { e.cancelled = true; f.cancels += 1; } };
  };
  /** advance virtual time and fire every due, live timer (in arm order); then let microtasks run */
  f.advance = async (ms) => { f.t += ms; for (const e of f.timers) if (!e.cancelled && !e.fired && e.due <= f.t) { e.fired = true; e.d.resolve(undefined); } await flush(); };
  /** fire the newest live timer NOW without advancing time (an early fire) */
  f.fireEarly = async () => { const e = [...f.timers].reverse().find((x) => !x.cancelled && !x.fired); e.fired = true; e.d.resolve(undefined); await flush(); };
  f.live = () => f.timers.filter((e) => !e.cancelled && !e.fired).length;
  f.deps = { monotonic: f.monotonic, timers: { arm: f.arm } };
  return f;
}
const guardOf = (f) => { const v = validateGuardDeps(f.deps); assert.equal(v.ok, true); return createGuard(v.deps); };

// ---------------------------------------------------------------------------------------------------------------------------------
test("G1 validateGuardDeps: exact shape, descriptor-only inspection; createGuard refuses unissued deps", () => {
  let getterRuns = 0;
  const f = fake();
  const bad = [undefined, null, 1, [], { monotonic: f.monotonic }, { ...f.deps, extra: 1 }, { monotonic: f.monotonic, timers: { arm: f.arm, x: 1 } },
    { monotonic: new Proxy(f.monotonic, {}), timers: { arm: f.arm } }, { monotonic: f.monotonic, timers: { arm: new Proxy(f.arm, {}) } },
    { monotonic: f.monotonic, timers: new Proxy({ arm: f.arm }, {}) }, new Proxy(f.deps, {}),
    Object.defineProperty({ timers: { arm: f.arm } }, "monotonic", { enumerable: true, get() { getterRuns += 1; return f.monotonic; } }),
    { monotonic: f.monotonic, timers: Object.defineProperty({}, "arm", { enumerable: true, get() { getterRuns += 1; return f.arm; } }) },
    { monotonic: 1, timers: { arm: f.arm } }, { monotonic: f.monotonic, timers: { arm: "x" } }, { monotonic: f.monotonic, timers: new (class T { arm() {} })() }];
  for (const b of bad) assert.deepEqual(validateGuardDeps(b), { ok: false, code: "GUARD_DEPS_INVALID" });
  assert.equal(getterRuns, 0);
  assert.equal(f.reads + f.armCalls.length, 0, "validation calls neither monotonic nor arm");
  const nul = Object.assign(Object.create(null), { monotonic: f.monotonic, timers: Object.assign(Object.create(null), { arm: f.arm }) });
  assert.equal(validateGuardDeps(nul).ok, true);
  assert.throws(() => createGuard({ monotonic: f.monotonic, arm: f.arm }), /GUARD_DEPS_INVALID/);
  assert.throws(() => createLifecycle({ guard: {} }), /LIFECYCLE_INVALID/);
});

test("G1/G3 invalid INITIAL timer handle or arm throw → not_started; start NEVER called; a safely identified cancel is disposed, getters never run", async () => {
  let getterRuns = 0;
  const handles = [
    () => { throw new Error("arm throws"); }, () => null, () => 5, () => new Proxy({ promise: Promise.resolve(), cancel() {} }, {}),
    () => ({ promise: new Proxy(new Promise(() => {}), {}), cancel() {} }), () => ({ promise: { then() {} }, cancel() {} }),
    () => { const p = new Promise(() => {}); p.then = () => {}; return { promise: p, cancel() {} }; },
    () => ({ promise: new Promise(() => {}), cancel: new Proxy(() => {}, {}) }),
    () => Object.defineProperty({ promise: new Promise(() => {}) }, "cancel", { enumerable: true, get() { getterRuns += 1; return () => {}; } }),
    () => Object.defineProperty({ cancel() {} }, "promise", { enumerable: true, get() { getterRuns += 1; return new Promise(() => {}); } }),
    () => ({ promise: new Promise(() => {}), cancel() {}, extra: 1 }), () => ({ promise: Promise.resolve() }),
    () => { class Sub extends Promise {} return { promise: new Sub(() => {}), cancel() {} }; }
  ];
  let safeCancels = 0;
  const withSafeCancel = () => ({ promise: new Promise(() => {}), cancel: () => { safeCancels += 1; }, extra: 1 });
  for (const h of [...handles, withSafeCancel]) {
    const f = fake(); const g = guardOf(f); let starts = 0;
    f.plan.push(h);
    const r = await g.observe(100, () => { starts += 1; return new Promise(() => {}); });
    assert.deepEqual({ ...r }, { kind: "not_started", started: false, code: "GUARD_TIMER_INVALID" });
    assert.equal(starts, 0, "start never called");
    assert.equal(g.armedCount(), 0);
    const again = await g.observe(200, () => { starts += 1; return Promise.resolve(); });
    assert.equal(again.code, "GUARD_BROKEN"); assert.equal(starts, 0);
  }
  assert.equal(getterRuns, 0, "no getter on an invalid handle ran");
  assert.equal(safeCancels, 1, "the safely identified cancel of an invalid handle was disposed");
});

test("G2/G3 pre-start: monotonic throw / NaN / decrease / expired / bad deadline / too-long delay → not_started, start not called", async () => {
  for (const [plan, code] of [[() => { throw new Error("m"); }, "GUARD_MONOTONIC_INVALID"], [() => NaN, "GUARD_MONOTONIC_INVALID"], [() => "1", "GUARD_MONOTONIC_INVALID"]]) {
    const f = fake(); const g = guardOf(f); f.monoPlan.push(plan); let starts = 0;
    const r = await g.observe(100, () => { starts += 1; return Promise.resolve(); });
    assert.equal(r.code, code); assert.equal(starts, 0); assert.equal(f.armCalls.length, 0);
  }
  { const f = fake(50); const g = guardOf(f); assert.equal(g.now().value, 50); f.t = 40; let starts = 0;
    const r = await g.observe(100, () => { starts += 1; return Promise.resolve(); }); assert.equal(r.code, "GUARD_MONOTONIC_INVALID", "decrease"); assert.equal(starts, 0); }
  const f = fake(10); const g = guardOf(f); let starts = 0; const st = () => { starts += 1; return Promise.resolve(); };
  assert.equal((await g.observe(10, st)).code, "EXPIRED_BEFORE_START");
  assert.equal((await g.observe(9.5, st)).code, "EXPIRED_BEFORE_START");
  assert.equal((await g.observe(NaN, st)).code, "GUARD_ARGUMENT_INVALID");
  assert.equal((await g.observe("20", st)).code, "GUARD_ARGUMENT_INVALID");
  assert.equal((await g.observe(20, "x")).code, "GUARD_ARGUMENT_INVALID");
  assert.equal((await g.observe(10 + MAX_DELAY_MS + 1, st)).code, "GUARD_DELAY_OUT_OF_RANGE");
  assert.equal(starts, 0); assert.equal(f.armCalls.length, 0); assert.equal(g.broken(), null, "pre-start refusals do not break the guard");
});

test("G4/G9 settle before the timer: outcome returned, timer cancelled, arm got ONLY the delay (this undefined); fractional remaining", async () => {
  const f = fake(0.25); const g = guardOf(f);
  const r1 = await g.observe(10, () => Promise.resolve("ok"));
  assert.equal(r1.kind, "fulfilled"); assert.equal(r1.value, "ok"); assert.equal(r1.started, true);
  assert.deepEqual(f.armCalls[0], [10], "ceil(9.75) = 10; one numeric argument"); assert.equal(f.armThis[0], undefined);
  assert.equal(f.cancels, 1); assert.equal(g.armedCount(), 0);
  const err = new Error("db");
  const r2 = await g.observe(1000.5, () => Promise.reject(err));
  assert.equal(r2.kind, "rejected"); assert.equal(r2.reason, err); assert.equal(r2.sync, false); assert.deepEqual(f.armCalls[1], [1001]);
  const r3 = await g.observe(20, () => { throw err; });
  assert.deepEqual([r3.kind, r3.reason, r3.sync, r3.op], ["rejected", err, true, null]);
  assert.equal(g.armedCount(), 0); assert.equal(f.cancels, 3);
  assert.equal(g.remaining(5).ms, 4.75);
  for (const [ms] of f.armCalls) assert.ok(Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_DELAY_MS);
  // non-native operation result: unobservable, never "never started", never assimilated
  let thenRuns = 0;
  const r4 = await g.observe(30, () => ({ then() { thenRuns += 1; } }));
  assert.deepEqual([r4.kind, r4.started, r4.code, r4.opState], ["observation_failed", true, "GUARD_OPERATION_NOT_NATIVE", "unobservable"]);
  assert.equal(thenRuns, 0); assert.equal(g.armedCount(), 0);
});

test("G5 hung op → timeout at the deadline; op RETAINED; late rejection side-handled (no unhandled leak); no retry", async () => {
  const f = fake(); const g = guardOf(f); const d = deferred(); let starts = 0;
  const p = g.observe(100, () => { starts += 1; return d.promise; });
  await f.advance(99); assert.equal(await stateOf(p), PENDING);
  await f.advance(1);
  const r = await p;
  assert.deepEqual([r.kind, r.started], ["timeout", true]); assert.equal(r.op, d.promise, "the original native promise is retained");
  d.reject(new Error("late")); await flush();
  assert.equal(starts, 1); assert.equal(g.armedCount(), 0);
});

test("G6 tie rule: an op settlement already recorded at the guard's decision point wins; a truly later settlement does not", async () => {
  // (a) timer fires, then the op settles, in the same synchronous batch
  for (const order of ["timer-first", "op-first"]) {
    for (const outcome of ["fulfil", "reject"]) {
      const f = fake(); const g = guardOf(f); const d = deferred();
      const p = g.observe(100, () => d.promise); await flush();
      const e = f.timers[0];
      const fireTimer = () => { f.t = 100; e.fired = true; e.d.resolve(undefined); };
      const settle = () => (outcome === "fulfil" ? d.resolve("v") : d.reject(new Error("x")));
      if (order === "timer-first") { fireTimer(); settle(); } else { settle(); fireTimer(); }
      const r = await p;
      assert.equal(r.kind, outcome === "fulfil" ? "fulfilled" : "rejected", `${order}/${outcome}`);
      assert.equal(g.armedCount(), 0);
    }
  }
  // (b) a settlement scheduled in a microtask well after the decision point → timeout; the op stays retained
  const f = fake(); const g = guardOf(f); const d = deferred();
  const p = g.observe(100, () => d.promise); await flush();
  f.t = 100; f.timers[0].fired = true; f.timers[0].d.resolve(undefined);
  (async () => { for (let i = 0; i < 50; i++) await null; d.resolve("late"); })();
  const r = await p;
  assert.equal(r.kind, "timeout"); assert.equal(r.op, d.promise);
  assert.equal(await r.op, "late");
});

test("G7 early fires: up to 3 re-arms for the remainder; the 4th early fire → post-start observation_failed with op retained", async () => {
  { const f = fake(); const g = guardOf(f); const d = deferred();
    const p = g.observe(100, () => d.promise); await flush();
    f.t = 40.5; await f.fireEarly(); f.t = 70; await f.fireEarly(); f.t = 99.9; await f.fireEarly();
    assert.deepEqual(f.armCalls.map((a) => a[0]), [100, 60, 30, 1], "re-armed for ceil(remaining)");
    await f.advance(1);                                   // the 1 ms re-arm made at 99.9 is due at 100.9
    const r = await p; assert.equal(r.kind, "timeout"); assert.equal(g.armedCount(), 0); }
  { const f = fake(); const g = guardOf(f); const d = deferred(); let starts = 0;
    const p = g.observe(100, () => { starts += 1; return d.promise; }); await flush();
    for (let i = 0; i < MAX_EARLY_FIRES + 1; i++) await f.fireEarly();
    const r = await p;
    assert.deepEqual([r.kind, r.started, r.code, r.opState, r.op === d.promise], ["observation_failed", true, "GUARD_TIMER_INVALID", "pending", true]);
    assert.equal(starts, 1, "no retry of start"); assert.equal(g.armedCount(), 0); assert.equal(g.broken(), "GUARD_TIMER_INVALID");
    assert.equal((await g.observe(500, () => Promise.resolve())).code, "GUARD_BROKEN"); }
});

test("clarification 1: post-start faults never erase outstanding work — re-arm throw / invalid re-arm / monotonic fault after wake / timer rejection / wrong value / cancel throw", async () => {
  const cases = [
    ["re-arm throws", (f) => { f.plan.push(() => { throw new Error("rearm"); }); return f.fireEarly(); }, "GUARD_TIMER_INVALID"],
    ["re-arm invalid handle", (f) => { f.plan.push(() => ({ promise: { then() {} }, cancel() {} })); return f.fireEarly(); }, "GUARD_TIMER_INVALID"],
    ["monotonic throws after wake", (f) => { f.monoPlan.push(() => { throw new Error("m"); }); return f.fireEarly(); }, "GUARD_MONOTONIC_INVALID"],
    ["monotonic decreases after wake", (f) => { f.monoPlan.push(() => -1); return f.fireEarly(); }, "GUARD_MONOTONIC_INVALID"],
    ["timer rejects", (f) => { const e = f.timers[0]; e.fired = true; e.d.reject(new Error("t")); return flush(); }, "GUARD_TIMER_FAILED"],
    ["timer fulfils with a value", (f) => { const e = f.timers[0]; e.fired = true; e.d.resolve(1); return flush(); }, "GUARD_TIMER_FAILED"]
  ];
  for (const [name, act, code] of cases) {
    const f = fake(); const g = guardOf(f); const d = deferred(); let starts = 0;
    const p = g.observe(100, () => { starts += 1; return d.promise; }); await flush();
    await act(f);
    const r = await p;
    assert.deepEqual([r.kind, r.started, r.code, r.opState], ["observation_failed", true, code, "pending"], name);
    assert.equal(r.op, d.promise, `${name}: op retained`); assert.equal(starts, 1, `${name}: no re-invocation`);
    assert.equal(g.armedCount(), 0, name);
    d.reject(new Error("late")); await flush();
  }
  // cancel throws after the op settled: outcome preserved inside the fault
  const f = fake(); const g = guardOf(f);
  f.plan.push(() => ({ promise: new Promise(() => {}), cancel: () => { throw new Error("cancel"); } }));
  const r = await g.observe(100, () => Promise.resolve("v"));
  assert.deepEqual([r.kind, r.code, r.opState, r.value], ["observation_failed", "GUARD_CANCEL_FAILED", "fulfilled", "v"]);
  assert.equal(g.cancelFailures(), 1); assert.equal(g.armedCount(), 0);
});

test("G8 wait: elapsed at min(delay, phase) — one arm, early fire re-armed, no residual timer; faults are code-only", async () => {
  const f = fake(); const g = guardOf(f);
  const p = g.wait(Math.min(30_000, 12_000)); await flush();
  assert.deepEqual(f.armCalls[0], [12_000]);
  f.t = 5_000; await f.fireEarly(); assert.deepEqual(f.armCalls[1], [7_000]);
  await f.advance(7_000);
  assert.deepEqual({ ...(await p) }, { kind: "elapsed" }); assert.equal(g.armedCount(), 0);
  assert.deepEqual({ ...(await g.wait(f.t)) }, { kind: "elapsed" }); assert.equal(f.armCalls.length, 2, "an already reached deadline arms nothing");
  const f2 = fake(); const g2 = guardOf(f2); const p2 = g2.wait(100); await flush();
  f2.timers[0].fired = true; f2.timers[0].d.reject(new Error("x"));
  assert.deepEqual({ ...(await p2) }, { kind: "observation_failed", started: false, code: "GUARD_TIMER_FAILED" });
  assert.equal(g2.armedCount(), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
function lockSpy(unlockImpl = () => Promise.resolve(true)) {
  const k = { unlocks: 0, destroys: 0, order: [] };
  k.handle = { unlock: () => { k.unlocks += 1; k.order.push("unlock"); return unlockImpl(); }, destroy: () => { k.destroys += 1; k.order.push("destroy"); } };
  return k;
}
const setup = (unlockImpl) => { const f = fake(); const g = guardOf(f); const lc = createLifecycle({ guard: g }); const k = lockSpy(unlockImpl); assert.equal(lc.attachLock(k.handle), true); return { f, g, lc, k }; };

test("L1 NONE → step fulfilled → tail settled → quiescent → one bounded unlock then destroy", async () => {
  const { lc, k, g } = setup();
  const ledger = createLedger(); const late = deferred();
  const r = await lc.observeStep({ phase: "reservation", deadline: 75_000, start: () => Promise.resolve(Object.freeze({ kind: "worked", late: late.promise })), ledger });
  assert.equal(r.kind, "fulfilled"); assert.equal(r.outstanding, "TAIL");
  const pt = lc.observeTail(35_000); await flush(); late.resolve([]);
  assert.equal((await pt).kind, "settled");
  // an already settled late becomes NONE before the step result is returned
  const { lc: lc0 } = setup();
  const r0 = await lc0.observeStep({ phase: "reservation", deadline: 75_000, start: () => Promise.resolve(Object.freeze({ late: Promise.resolve([]) })), ledger: createLedger() });
  assert.equal(r0.outstanding, "NONE"); assert.equal((await lc0.observeTail(35_000)).kind, "settled");
  assert.equal(lc.snapshot().outstanding, "NONE");
  const d = await lc.finalize();
  assert.deepEqual({ ...d }, { quiescence: "observed", lockRelease: "unlocked", exclusionLost: false, lateClientsDestroyed: 0, timerCancelFailures: 0, timersCancelledAtDisposal: 0 });
  assert.deepEqual(k.order, ["unlock", "destroy"]); assert.equal(g.armedCount(), 0);
  // refused gate result without `late` → NONE directly
  const { lc: lc2 } = setup();
  const r2 = await lc2.observeStep({ phase: "capture", deadline: 75_000, start: () => Promise.resolve(Object.freeze({ kind: "refused", code: "X" })), ledger: createLedger() });
  assert.equal(r2.outstanding, "NONE");
});

test("L2 STEP → TAIL → quiescent: ownership before start; result frozen; finalize waits for the step AND its late, then unlocks", async () => {
  const { f, lc, k } = setup();
  const step = deferred(); const late = deferred(); let sawState = null;
  const pr = lc.observeStep({ phase: "reservation", deadline: 75_000, ledger: createLedger(), start: () => { sawState = lc.snapshot().outstanding; return step.promise; } });
  await f.advance(75_000);
  const r = await pr;
  assert.equal(sawState, "STEP", "state ownership began before the start callback ran");
  assert.deepEqual([r.kind, r.outstanding], ["timeout", "STEP"]); assert.ok(Object.isFrozen(r));
  const fin = lc.finalize();
  await f.advance(10_000_000); assert.equal(await stateOf(fin), PENDING);
  step.resolve(Object.freeze({ kind: "worked", late: late.promise })); await flush();
  assert.equal(lc.snapshot().outstanding, "TAIL"); assert.equal(await stateOf(fin), PENDING);
  assert.equal(k.unlocks + k.destroys, 0, "no unlock / destroy while work is outstanding");
  late.resolve([]); await flush();
  const d = await fin;
  assert.equal(d.lockRelease, "unlocked"); assert.deepEqual(k.order, ["unlock", "destroy"]);
  assert.deepEqual([r.kind, r.outstanding], ["timeout", "STEP"], "the earlier frozen result is unchanged");
});

test("L3 STEP → late rejection: started 0 → destroy-only (never unlock); started > 0 → unobservable forever, even after executor promises settle", async () => {
  { const { f, lc, k } = setup(); const step = deferred();
    const pr = lc.observeStep({ phase: "reservation", deadline: 75_000, ledger: createLedger(), start: () => step.promise });
    await f.advance(75_000); assert.equal((await pr).kind, "timeout");
    lc.stop("TIMEOUT_STEP");
    step.reject(new Error("worker db error")); await flush();
    const d = await lc.finalize();
    assert.equal(d.lockRelease, "destroyed"); assert.equal(k.unlocks, 0); assert.equal(k.destroys, 1);
    assert.equal(lc.snapshot().stopCode, "TIMEOUT_STEP", "first cause unchanged"); }
  { const { f, lc, k } = setup(); const step = deferred(); const exec = deferred();
    const ledger = createLedger();
    const w = wrapExecutors({ createReservation: () => exec.promise }, ledger);
    const pr = lc.observeStep({ phase: "reservation", deadline: 75_000, ledger, start: () => { w.executors.createReservation({}); return step.promise; } });
    await f.advance(75_000); assert.equal((await pr).kind, "timeout");
    step.reject(new Error("worker db error")); await flush();
    assert.deepEqual([lc.snapshot().outstanding, lc.snapshot().tailObservable], ["TAIL", false]);
    const fin = lc.finalize();
    exec.resolve({}); await flush(); assert.equal(ledger.snapshot().settled, 1);
    await f.advance(100_000_000); assert.equal(await stateOf(fin), PENDING, "conservatively unobservable");
    assert.equal(k.unlocks + k.destroys, 0); }
  // rejection WITHIN the deadline after an executor start → TAIL unobservable immediately
  { const { lc, k } = setup(); const ledger = createLedger(); const w = wrapExecutors({ lookupPage: () => new Promise(() => {}) }, ledger);
    const r = await lc.observeStep({ phase: "capture", deadline: 75_000, ledger, start: () => { w.executors.lookupPage(); return Promise.reject(new Error("db")); } });
    assert.deepEqual([r.kind, r.outstanding], ["rejected", "TAIL"]); assert.equal(lc.snapshot().tailObservable, false);
    assert.equal(await stateOf(lc.finalize()), PENDING); assert.equal(k.unlocks + k.destroys, 0); }
});

test("L4 post-result TAIL never settles → finalize pending; lock untouched; no new invocation", async () => {
  const { f, lc, k } = setup(); let starts = 0;
  await lc.observeStep({ phase: "cleanup", deadline: 75_000, ledger: createLedger(), start: () => { starts += 1; return Promise.resolve(Object.freeze({ late: new Promise(() => {}) })); } });
  const pt = lc.observeTail(35_000); await f.advance(35_000);
  assert.equal((await pt).kind, "timeout");
  const fin = lc.finalize(); await f.advance(1e9);
  assert.equal(await stateOf(fin), PENDING); assert.equal(k.unlocks + k.destroys, 0); assert.equal(starts, 1);
  assert.equal((await lc.observeStep({ phase: "cleanup", deadline: 1e9, ledger: createLedger(), start: () => { starts += 1; return Promise.resolve(); } })).code, "LIFECYCLE_FINALIZING");
  assert.equal(starts, 1);
});

test("L5 DB-family path: destroy only, unlock never called; no forbidden callback after the DB failure", async () => {
  const { lc, k } = setup();
  lc.stop("DB_FAILURE"); lc.markDbFamily();
  const d = await lc.finalize();
  assert.equal(d.lockRelease, "destroyed"); assert.equal(k.unlocks, 0); assert.equal(k.destroys, 1);
});

test("L6 lock loss with an outstanding STEP: destroyed once, marked lost, step still awaited, never unlocked; trackClient event orders", async () => {
  const { f, lc, k } = setup();
  const listeners = new Map(); let unsub = 0; let destroys = 0; let losses = 0;
  const t = trackClient({ subscribe: (ev, h) => listeners.set(ev, h), unsubscribe: (ev, h) => { if (listeners.get(ev) === h) { listeners.delete(ev); unsub += 1; } },
    destroy: () => { destroys += 1; }, onLoss: () => { losses += 1; lc.lockLost(); } });
  assert.equal(t.ok, true);
  const step = deferred();
  const pr = lc.observeStep({ phase: "capture", deadline: 75_000, ledger: createLedger(), start: () => step.promise });
  await f.advance(75_000); assert.equal((await pr).kind, "timeout");
  lc.stop("TIMEOUT_STEP");
  listeners.get("end")(); listeners.get("error")(new Error("after end"));
  assert.deepEqual([destroys, losses, t.tracker.state()], [1, 1, "lost"]);
  assert.equal(k.destroys, 1, "lifecycle destroyed its lock handle once"); lc.lockLost(); assert.equal(k.destroys, 1);
  assert.equal(lc.snapshot().exclusion, "lost"); assert.equal(lc.snapshot().stopCode, "TIMEOUT_STEP"); assert.equal(lc.snapshot().outstanding, "STEP", "loss never implies the step was cancelled");
  const fin = lc.finalize(); assert.equal(await stateOf(fin), PENDING);
  step.resolve(Object.freeze({ kind: "worked" })); await flush();
  const d = await fin;
  assert.deepEqual([d.lockRelease, d.exclusionLost], ["lost", true]); assert.equal(k.unlocks, 0); assert.equal(k.destroys, 1);
  t.tracker.dispose(); t.tracker.dispose(); assert.equal(unsub, 2); assert.equal(listeners.size, 0);
  // runner-initiated destroy, then pg's own 'end' → no loss, no double destroy
  const L2 = new Map(); let d2 = 0; let l2 = 0;
  const t2 = trackClient({ subscribe: (ev, h) => L2.set(ev, h), unsubscribe: () => {}, destroy: () => { d2 += 1; }, onLoss: () => { l2 += 1; } });
  assert.equal(t2.tracker.destroy(), true); assert.equal(t2.tracker.destroy(), false); L2.get("end")(); L2.get("error")(new Error("x"));
  assert.deepEqual([d2, l2, t2.tracker.state()], [1, 0, "destroyed"]);
  // error first, then end
  const L3 = new Map(); let d3 = 0; let l3 = 0;
  const t3 = trackClient({ subscribe: (ev, h) => L3.set(ev, h), unsubscribe: () => {}, destroy: () => { d3 += 1; }, onLoss: () => { l3 += 1; } });
  L3.get("error")(new Error("e")); L3.get("end")(); assert.equal(t3.tracker.destroy(), false);
  assert.deepEqual([d3, l3], [1, 1]);
  // subscribe failure → refused, destroyed once; invalid shapes refused
  let d4 = 0;
  assert.deepEqual(trackClient({ subscribe: () => { throw new Error("s"); }, unsubscribe: () => {}, destroy: () => { d4 += 1; }, onLoss: () => {} }), { ok: false, code: "TRACK_SUBSCRIBE_FAILED" });
  assert.equal(d4, 1);
  assert.equal(trackClient({ subscribe() {}, unsubscribe() {}, destroy() {} }).code, "TRACK_INVALID");
});

test("L7 unlock times out / returns false / rejects / returns a non-boolean → destroyed once, no retry", async () => {
  for (const [impl, release, lostFlag] of [[() => new Promise(() => {}), "destroyed_after_unlock_timeout", false], [() => Promise.resolve(false), "destroyed_after_unlock_failure", true],
    [() => Promise.reject(new Error("u")), "destroyed_after_unlock_failure", false], [() => Promise.resolve("yes"), "destroyed_after_unlock_failure", false]]) {
    const { f, lc, k } = setup(impl);
    const fin = lc.finalize(); await flush();
    await f.advance(LIMITS.UNLOCK_MS);
    const d = await fin;
    assert.deepEqual([d.lockRelease, d.exclusionLost, k.unlocks, k.destroys], [release, lostFlag, 1, 1], release);
  }
});

test("L8 finalize is ONE memoized promise: repeated, concurrent and post-resolution calls; disposal runs once", async () => {
  const { lc, k } = setup();
  const a = lc.finalize(); const b = lc.finalize();
  assert.equal(a, b);
  const [x, y] = await Promise.all([a, b]);
  assert.equal(x, y); assert.equal(lc.finalize(), a);
  assert.deepEqual([k.unlocks, k.destroys], [1, 1]);
  const lcNone = createLifecycle({ guard: guardOf(fake()) });
  assert.equal((await lcNone.finalize()).lockRelease, "not_acquired");
});

test("L9 late acquired client: destroyed exactly once, never queried; late rejection swallowed; in-time client handed over", async () => {
  const { f, lc } = setup();
  const conn = deferred(); const destroyed = [];
  const pc = lc.observeConnect(f.t + LIMITS.CONNECT_MS, () => conn.promise, (c) => destroyed.push(c));
  await f.advance(LIMITS.CONNECT_MS);
  assert.deepEqual({ ...(await pc) }, { kind: "timeout" });
  let queries = 0; const client = { query: () => { queries += 1; } };
  conn.resolve(client); await flush();
  assert.deepEqual([destroyed.length, destroyed[0] === client, queries], [1, true, 0]);
  const conn2 = deferred();
  const pc2 = lc.observeConnect(f.t + LIMITS.CONNECT_MS, () => conn2.promise, () => destroyed.push("x"));
  await f.advance(LIMITS.CONNECT_MS); assert.equal((await pc2).kind, "timeout");
  conn2.reject(new Error("late connect failure")); await flush();
  assert.equal(destroyed.length, 1, "a late rejection destroys nothing and is swallowed");
  const ok = await lc.observeConnect(f.t + LIMITS.CONNECT_MS, () => Promise.resolve(client), () => destroyed.push("y"));
  assert.equal(ok.client, client); assert.equal(destroyed.length, 1);
  lc.markDbFamily();
  const d = await lc.finalize(); assert.equal(d.lateClientsDestroyed, 1);
});

test("L10 first cause wins; later conditions are flags only; busy / finalizing refusals never call start", async () => {
  const { f, lc } = setup();
  lc.stop("TIMEOUT_STEP"); lc.lockLost(); lc.stop("LOCK_LOST");
  assert.deepEqual([lc.snapshot().stopCode, lc.snapshot().exclusion], ["TIMEOUT_STEP", "lost"]);
  const { lc: b } = setup();
  b.stop("DB_FAILURE"); b.markDbFamily(); b.stop("TIMEOUT_JOURNAL"); b.stop("not a code");
  assert.deepEqual([b.snapshot().stopCode, b.snapshot().dbFamily], ["DB_FAILURE", true]);
  let starts = 0; const step = deferred();
  const p1 = lc.observeStep({ phase: "recording", deadline: 90_000, ledger: createLedger(), start: () => { starts += 1; return step.promise; } });
  const busy = await lc.observeStep({ phase: "recording", deadline: 90_000, ledger: createLedger(), start: () => { starts += 1; return Promise.resolve(); } });
  assert.equal(busy.code, "LIFECYCLE_BUSY"); assert.equal(starts, 1);
  for (const bad of [{ phase: "nope", deadline: 1, ledger: createLedger(), start: () => {} }, { phase: "recording", deadline: 1, ledger: {}, start: () => {} }, null]) {
    assert.equal((await lc.observeStep(bad)).code, "LIFECYCLE_ARGUMENT_INVALID");
  }
  step.resolve(Object.freeze({})); await f.advance(0); await p1;
});

test("guard fault during a STEP: promise retained, healthy lock kept until quiescence, then destroy-only (guard cannot bound an unlock)", async () => {
  const { f, lc, k } = setup(); const step = deferred();
  const pr = lc.observeStep({ phase: "reservation", deadline: 75_000, ledger: createLedger(), start: () => step.promise }); await flush();
  f.plan.push(() => { throw new Error("rearm"); });
  await f.fireEarly();
  const r = await pr;
  assert.deepEqual([r.kind, r.code, r.outstanding], ["observation_failed", "GUARD_TIMER_INVALID", "STEP"]);
  const fin = lc.finalize(); await flush(); assert.equal(await stateOf(fin), PENDING); assert.equal(k.unlocks + k.destroys, 0);
  step.resolve(Object.freeze({ kind: "worked" })); await flush();
  const d = await fin; assert.equal(d.lockRelease, "destroyed"); assert.equal(k.unlocks, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
test("W1 executor wrappers: same keys, label unchanged, identical args / this / promise / error; code-only refusals; one settle per call", async () => {
  let trapRuns = 0;
  const hostileArg = new Proxy({}, { get() { trapRuns += 1; }, ownKeys() { trapRuns += 1; return []; }, getPrototypeOf() { trapRuns += 1; return null; } });
  const seen = [];
  const lookup = deferred();
  const refusal = new ExecutorRefusal("RESERVATION_UNBOUND");
  const transport = new Error("transport");
  let forgedRuns = 0;
  const forged = Object.create(ExecutorRefusal.prototype, { code: { enumerable: true, get() { forgedRuns += 1; return "FORGED"; } } });
  const proxiedErr = new Proxy(new ExecutorRefusal("PROXIED"), { getPrototypeOf() { trapRuns += 1; return ExecutorRefusal.prototype; }, getOwnPropertyDescriptor() { trapRuns += 1; } });
  const pricing = { get(...a) { seen.push(["get", this, a]); return Promise.resolve("g"); }, post() { return Promise.reject(refusal); } };
  const label = Object.freeze({ accountRef: "acct-test-1", clientSnapshotId: "client-RUN" });
  const ex = { pricing, lookupPage(...a) { seen.push(["lookupPage", this, a]); return lookup.promise; },
    retrieveReservation() { throw refusal; }, createReservation() { return Promise.reject(transport); },
    cancelReservation() { return Promise.reject(forged); }, listOfflineCharges() { throw proxiedErr; }, label };
  const ledger = createLedger();
  const w = wrapExecutors(ex, ledger);
  assert.equal(w.ok, true);
  assert.deepEqual(Object.keys(w.executors), Object.keys(ex)); assert.equal(w.executors.label, label);
  assert.deepEqual(Object.keys(w.executors.pricing), ["get", "post"]);
  const r1 = w.executors.lookupPage(hostileArg, 7);
  assert.equal(r1, lookup.promise, "identical promise object"); assert.equal(seen[0][1], ex, "this = the original container");
  assert.equal(seen[0][2][0], hostileArg); assert.equal(seen[0][2][1], 7);
  assert.equal(await w.executors.pricing.get("/x"), "g"); assert.equal(seen[1][1], pricing);
  await assert.rejects(w.executors.pricing.post(), (e) => e === refusal);
  assert.throws(() => w.executors.retrieveReservation(), (e) => e === refusal);
  await assert.rejects(w.executors.createReservation(), (e) => e === transport);
  await assert.rejects(w.executors.cancelReservation(), (e) => e === forged);
  assert.throws(() => w.executors.listOfflineCharges(), (e) => e === proxiedErr);
  await flush();
  let s = ledger.snapshot();
  assert.deepEqual([s.started, s.settled], [7, 6], "the pending lookup has not settled");
  assert.deepEqual(s.refusals.map((x) => ({ ...x })), [{ key: "pricing.post", code: "RESERVATION_UNBOUND" }, { key: "retrieveReservation", code: "RESERVATION_UNBOUND" }]);
  const drained = ledger.whenDrained(); assert.equal(await stateOf(drained), PENDING);
  lookup.resolve({}); await flush();
  s = ledger.snapshot(); assert.deepEqual([s.started, s.settled], [7, 7]); assert.equal(await stateOf(drained) === PENDING, false);
  assert.equal(trapRuns, 0, "hostile arguments / proxied errors never inspected"); assert.equal(forgedRuns, 0, "forged accessor code never executed");
  // non-native result: returned identically, settles once, but the ledger can never drain
  const L2 = createLedger(); const thenable = { then() { trapRuns += 1; } };
  const w2 = wrapExecutors({ lookupPage: () => thenable }, L2);
  assert.equal(w2.executors.lookupPage(), thenable);
  assert.deepEqual({ ...L2.snapshot(), refusals: [] }, { started: 1, settled: 1, nonNative: 1, refusals: [] });
  assert.equal(await stateOf(L2.whenDrained()), PENDING); assert.equal(trapRuns, 0);
  // invalid executor sets
  let getterRuns = 0;
  for (const bad of [null, [], new Proxy({}, {}), { a: 1 }, { a: new Proxy(() => {}, {}) }, { pricing: { get() {} } }, { pricing: { get() {}, post() {}, x() {} } },
    Object.defineProperty({}, "a", { enumerable: true, get() { getterRuns += 1; return () => {}; } }), new (class E { a() {} })()]) {
    assert.deepEqual(wrapExecutors(bad, createLedger()), { ok: false, code: "EXECUTORS_INVALID" });
  }
  assert.deepEqual(wrapExecutors({ a() {} }, {}), { ok: false, code: "EXECUTORS_INVALID" }, "unissued ledger");
  assert.equal(getterRuns, 0);
});

test("isNativePromise: only genuine, unpatched native promises", () => {
  assert.equal(isNativePromise(Promise.resolve()), true);
  const own = Promise.resolve(); own.then = () => {};
  class Sub extends Promise {}
  for (const x of [null, {}, { then() {} }, new Proxy(Promise.resolve(), {}), own, Sub.resolve(1)]) assert.equal(isNativePromise(x), false);
});

test("P1 purity: no own timers / env / network / fs / pinned identifiers; exact import list", () => {
  const src = readFileSync(new URL("../scripts/e7-connected/run-guard.mjs", import.meta.url), "utf8");
  const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const re of [/setTimeout|setInterval|setImmediate|queueMicrotask/, /process\./, /\bfetch\s*\(/, /node:(fs|net|https?|child_process|timers)/, /\bSELECT\b|\bUPDATE\b|\bpg_/i,
    /hostaway-reservations/, /connectedTestAdapterConfig/, /allowRequest:/, /booking-db|reservation-worker|capture-worker|recording-worker|compensation-worker/, /performance\.now|Date\.now/]) {
    assert.doesNotMatch(code, re, String(re));
  }
  const imports = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./executor-adapters.mjs", "node:util"]);
});
