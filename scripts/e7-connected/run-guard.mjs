// scripts/e7-connected/run-guard.mjs — E7 connected-test runner SLICE B: deadline guard, outstanding-work lifecycle, executor wrappers.
// Contract: claude/e7-connected-runner-contract.md §2.2, §5.3, §7.2–§7.7, §9.1. OFFLINE foundation: pure helpers over INJECTED
// dependencies. No SQL text, no worker import, no pool / client / transport / env / fs / fetch / SDK, and NO timer of its own: every
// wait goes through the injected `timers.arm`, every deadline through the injected `monotonic`.
//
// Native-promise requirement: every promise this module observes (timer handles, operation / step / tail / unlock results, executor
// results) must be a genuine native Promise — not a proxy, prototype exactly Promise.prototype, no own `then`. Settlement is read ONLY
// through the intrinsic Promise.prototype.then captured at module load; no caller `then`, getter or thenable is ever assimilated.
// A function that throws synchronously is a rejection; a function that returns anything other than a native promise is UNOBSERVABLE
// (never "never started", never assimilated).
import { types } from "node:util";
import { ExecutorRefusal } from "./executor-adapters.mjs";

// ---- intrinsics captured at load ------------------------------------------------------------------------------------------------
const NativePromise = Promise;
const PROMISE_PROTO = Promise.prototype;
const OBJECT_PROTO = Object.prototype;
const REFUSAL_PROTO = ExecutorRefusal.prototype;
const pThen = Promise.prototype.then;
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const getDescs = Object.getOwnPropertyDescriptors;
const getDesc = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const freeze = Object.freeze;
const isFiniteNum = Number.isFinite;
const ceil = Math.ceil;
const { isProxy, isPromise } = types;

// ---- fixed limits (contract §7.2; routine technical choices) ---------------------------------------------------------------------
export const RUN_GUARD_VERSION = "e7-run-guard-v1";
export const MAX_DELAY_MS = 1_800_000;
export const MAX_EARLY_FIRES = 3;
export const LIMITS = freeze({ CONNECT_MS: 5_000, STATEMENT_MS: 5_000, SNAPSHOT_MS: 15_000, LOCK_ACQUIRE_MS: 5_000, UNLOCK_MS: 5_000,
  STEP_MARGIN_MS: 30_000, TAIL_OBSERVE_MS: 35_000, JOURNAL_MS: 5_000, ATTEST_MS: 1_800_000 });
export const STEP_PHASES = freeze(["reservation", "capture", "recording", "cleanup"]);
const CODE_RE = /^[A-Z][A-Z0-9_]{0,47}$/;
const REFUSAL_CODE_RE = /^[A-Z_]{1,40}$/;

// ---- safe inspection --------------------------------------------------------------------------------------------------------------
const isFn = (f) => typeof f === "function" && !isProxy(f);
const isPlainObj = (o) => o !== null && typeof o === "object" && !isProxy(o) && (getProto(o) === OBJECT_PROTO || getProto(o) === null);
export function isNativePromise(p) {
  return p !== null && typeof p === "object" && !isProxy(p) && isPromise(p) && getProto(p) === PROMISE_PROTO && getDesc(p, "then") === undefined;
}
/** own DATA properties exactly `keys` (any order) → descriptor map, else null. Never invokes a getter. */
function dataKeys(o, keys) {
  const d = getDescs(o);
  const ks = ownKeys(d);
  if (ks.length !== keys.length) return null;
  for (const k of ks) if (typeof k !== "string" || !keys.includes(k) || !("value" in d[k])) return null;
  return d;
}
/** attach side handlers through the intrinsic then; handlers never throw, so the derived promise never rejects (no unhandled leak) */
function sideHandle(p, onFulfilled, onRejected) {
  apply(pThen, p, [(v) => { try { onFulfilled(v); } catch { /* contained */ } }, (e) => { try { onRejected(e); } catch { /* contained */ } }]);
}
const never = () => new NativePromise(() => {});

// ---- dependency validation ------------------------------------------------------------------------------------------------------
const ISSUED_DEPS = new WeakSet();
const GUARDS = new WeakSet();
const LEDGERS = new WeakMap();

/** validateGuardDeps({ monotonic, timers:{ arm } }) → frozen { ok:true, deps } | frozen { ok:false, code:'GUARD_DEPS_INVALID' }.
 *  Descriptor-only inspection: no getter, proxy or caller method runs; `arm` and `monotonic` are not called. */
export function validateGuardDeps(input) {
  try {
    if (!isPlainObj(input)) return freeze({ ok: false, code: "GUARD_DEPS_INVALID" });
    const d = dataKeys(input, ["monotonic", "timers"]);
    if (!d || !isFn(d.monotonic.value) || !isPlainObj(d.timers.value)) return freeze({ ok: false, code: "GUARD_DEPS_INVALID" });
    const t = dataKeys(d.timers.value, ["arm"]);
    if (!t || !isFn(t.arm.value)) return freeze({ ok: false, code: "GUARD_DEPS_INVALID" });
    const deps = freeze({ monotonic: d.monotonic.value, arm: t.arm.value });
    ISSUED_DEPS.add(deps);
    return freeze({ ok: true, deps });
  } catch { return freeze({ ok: false, code: "GUARD_DEPS_INVALID" }); }
}

// ---- guard ------------------------------------------------------------------------------------------------------------------------
const notStarted = (code) => freeze({ kind: "not_started", started: false, code });

/** createGuard(deps) → frozen guard. Throws TypeError('GUARD_DEPS_INVALID') unless `deps` came from validateGuardDeps. */
export function createGuard(deps) {
  if (!ISSUED_DEPS.has(deps)) throw new TypeError("GUARD_DEPS_INVALID");
  const { monotonic, arm: armFn } = deps;
  let last = -Infinity;
  let broken = null;
  let cancelFailures = 0;
  const armed = new Set();
  const breakWith = (code) => { if (!broken) broken = code; };

  /** one monotonic reading; any fault latches GUARD_MONOTONIC_INVALID and returns null */
  function read() {
    let v;
    try { v = apply(monotonic, undefined, []); } catch { breakWith("GUARD_MONOTONIC_INVALID"); return null; }
    if (typeof v !== "number" || !isFiniteNum(v) || v < last) { breakWith("GUARD_MONOTONIC_INVALID"); return null; }
    last = v;
    return v;
  }
  /** arm(ms) → { ok:true, entry, promise } | { ok:false }. `arm` receives ONLY the number; it is called with this === undefined.
   *  An invalid handle is never used; its `cancel` is called only when it is safely identified (own data property, non-proxy function). */
  function armTimer(ms) {
    let h;
    try { h = apply(armFn, undefined, [ms]); } catch { return { ok: false }; }
    let d = null;
    try {
      if (!isPlainObj(h)) return { ok: false };
      d = getDescs(h);
      const ks = ownKeys(d);
      const valid = ks.length === 2 && ks.every((k) => k === "promise" || k === "cancel") && "value" in d.promise && "value" in d.cancel
        && isNativePromise(d.promise.value) && isFn(d.cancel.value);
      if (valid) {
        const entry = { cancel: d.cancel.value, done: false, kind: null, value: undefined };
        armed.add(entry);
        return { ok: true, entry, promise: d.promise.value };
      }
    } catch { /* fall through: invalid */ }
    try { if (d && d.cancel && "value" in d.cancel && isFn(d.cancel.value)) apply(d.cancel.value, undefined, []); } catch { cancelFailures += 1; }
    return { ok: false };
  }
  function fired(entry) { entry.done = true; armed.delete(entry); }
  function cancelEntry(entry) {
    if (entry.done) return true;
    entry.done = true; armed.delete(entry);
    try { apply(entry.cancel, undefined, []); return true; } catch { cancelFailures += 1; return false; }
  }

  /** shared waiting loop: resolves when the op settles (if any) or the deadline is reached by monotonic, re-arming early fires */
  async function run(deadline, first, st) {
    let cur = first;
    let early = 0;
    let wakeR = null;
    const wake = () => { const w = wakeR; wakeR = null; if (w) w(); };
    if (st) st.wake = wake;
    const listen = (x) => sideHandle(x.promise, (v) => { x.entry.kind = "fulfilled"; x.entry.value = v; if (x === cur) wake(); },
      () => { x.entry.kind = "rejected"; if (x === cur) wake(); });
    listen(cur);
    for (;;) {
      if ((!st || st.s === "pending") && cur.entry.kind === null) await new NativePromise((r) => { wakeR = r; });
      // ---- decision point: an op settlement ALREADY RECORDED here wins over the timer ----
      if (st && st.s !== "pending") {
        if (cur.entry.kind !== null) fired(cur.entry);
        else if (!cancelEntry(cur.entry)) { breakWith("GUARD_CANCEL_FAILED"); return { fault: "GUARD_CANCEL_FAILED" }; }
        return { settled: true };
      }
      fired(cur.entry);
      if (cur.entry.kind === "rejected" || cur.entry.value !== undefined) { breakWith("GUARD_TIMER_FAILED"); return { fault: "GUARD_TIMER_FAILED" }; }
      const t = read();
      if (t === null) return { fault: "GUARD_MONOTONIC_INVALID" };
      if (t >= deadline) return { expired: true };
      early += 1;
      if (early > MAX_EARLY_FIRES) { breakWith("GUARD_TIMER_INVALID"); return { fault: "GUARD_TIMER_INVALID" }; }
      const n = armTimer(ceil(deadline - t));
      if (!n.ok) { breakWith("GUARD_TIMER_INVALID"); return { fault: "GUARD_TIMER_INVALID" }; }
      cur = n;
      listen(cur);
    }
  }

  /** pre-start checks shared by observe / wait → { ok:true, a } | not_started result */
  function prestart(deadline) {
    if (broken) return notStarted("GUARD_BROKEN");
    if (typeof deadline !== "number" || !isFiniteNum(deadline)) return notStarted("GUARD_ARGUMENT_INVALID");
    const now = read();
    if (now === null) return notStarted("GUARD_MONOTONIC_INVALID");
    const rem = deadline - now;
    if (!(rem > 0)) return notStarted("EXPIRED_BEFORE_START");
    const ms = ceil(rem);
    if (ms > MAX_DELAY_MS) return notStarted("GUARD_DELAY_OUT_OF_RANGE");
    const a = armTimer(ms);
    if (!a.ok) { breakWith("GUARD_TIMER_INVALID"); return notStarted("GUARD_TIMER_INVALID"); }
    return { ok: true, a };
  }

  /** observe(deadline, start) → Promise<frozen ObserveResult> (contract §7.2). `start` is called at most once, with no arguments and
   *  this === undefined, ONLY after the initial timer handle validated. Result kinds:
   *   { kind:'not_started', started:false, code }                         start was NOT called
   *   { kind:'fulfilled', started:true, value, op }                         settled within the deadline
   *   { kind:'rejected', started:true, reason, op, sync }                   reason kept for runner classification only
   *   { kind:'timeout', started:true, op }                                  op RETAINED (still pending; late rejection side-handled)
   *   { kind:'observation_failed', started:true, code, op, opState, value?, reason? }   post-start guard fault; op RETAINED */
  async function observe(deadline, start) {
    if (!isFn(start)) return notStarted("GUARD_ARGUMENT_INVALID");
    const p = prestart(deadline);
    if (!p.ok) return p;
    let op;
    try { op = apply(start, undefined, []); } catch (e) {
      if (!cancelEntry(p.a.entry)) { breakWith("GUARD_CANCEL_FAILED"); return freeze({ kind: "observation_failed", started: true, code: "GUARD_CANCEL_FAILED", op: null, opState: "rejected", reason: e }); }
      return freeze({ kind: "rejected", started: true, reason: e, op: null, sync: true });
    }
    if (!isNativePromise(op)) {
      breakWith("GUARD_OPERATION_NOT_NATIVE"); cancelEntry(p.a.entry);
      return freeze({ kind: "observation_failed", started: true, code: "GUARD_OPERATION_NOT_NATIVE", op: null, opState: "unobservable" });
    }
    const st = { s: "pending", v: undefined, r: undefined, wake: null };
    sideHandle(op, (v) => { st.s = "fulfilled"; st.v = v; if (st.wake) st.wake(); }, (e) => { st.s = "rejected"; st.r = e; if (st.wake) st.wake(); });
    const out = await run(deadline, p.a, st);
    if (out.fault) {
      return freeze({ kind: "observation_failed", started: true, code: out.fault, op, opState: st.s,
        ...(st.s === "fulfilled" ? { value: st.v } : {}), ...(st.s === "rejected" ? { reason: st.r } : {}) });
    }
    if (out.expired) return freeze({ kind: "timeout", started: true, op });
    return st.s === "fulfilled" ? freeze({ kind: "fulfilled", started: true, value: st.v, op }) : freeze({ kind: "rejected", started: true, reason: st.r, op, sync: false });
  }

  /** wait(deadline) → Promise<frozen { kind:'elapsed' } | not_started | { kind:'observation_failed', started:false, code }>.
   *  A deadline already reached is 'elapsed' without arming. Timer fulfilment at/after the deadline is the NORMAL end. */
  async function wait(deadline) {
    if (broken) return notStarted("GUARD_BROKEN");
    if (typeof deadline !== "number" || !isFiniteNum(deadline)) return notStarted("GUARD_ARGUMENT_INVALID");
    const now = read();
    if (now === null) return notStarted("GUARD_MONOTONIC_INVALID");
    if (!(deadline - now > 0)) return freeze({ kind: "elapsed" });
    const p = prestart(deadline);
    if (!p.ok) return p.code === "EXPIRED_BEFORE_START" ? freeze({ kind: "elapsed" }) : p;
    const out = await run(deadline, p.a, null);
    if (out.fault) return freeze({ kind: "observation_failed", started: false, code: out.fault });
    return freeze({ kind: "elapsed" });
  }

  const guard = freeze({
    observe, wait,
    /** now() → frozen { ok:true, value } | { ok:false, code } */
    now: () => { if (broken) return freeze({ ok: false, code: broken }); const v = read(); return v === null ? freeze({ ok: false, code: "GUARD_MONOTONIC_INVALID" }) : freeze({ ok: true, value: v }); },
    /** remaining(deadline) → frozen { ok:true, ms } | { ok:false, code } (ms may be ≤ 0 or fractional) */
    remaining: (deadline) => {
      if (broken) return freeze({ ok: false, code: broken });
      if (typeof deadline !== "number" || !isFiniteNum(deadline)) return freeze({ ok: false, code: "GUARD_ARGUMENT_INVALID" });
      const v = read(); return v === null ? freeze({ ok: false, code: "GUARD_MONOTONIC_INVALID" }) : freeze({ ok: true, ms: deadline - v });
    },
    armedCount: () => armed.size,
    /** cancelAll() → frozen { cancelled, failures } — cancels every still-armed timer once */
    cancelAll: () => { let c = 0; let f = 0; for (const e of [...armed]) { if (cancelEntry(e)) c += 1; else f += 1; } return freeze({ cancelled: c, failures: f }); },
    broken: () => broken,
    cancelFailures: () => cancelFailures
  });
  GUARDS.add(guard);
  return guard;
}

// ---- executor ledger + wrappers (contract §5.3) -----------------------------------------------------------------------------------
/** createLedger() → frozen { snapshot(), whenDrained() }.
 *  snapshot() → frozen { started, settled, nonNative, refusals: frozen [{ key, code }] }.
 *  whenDrained() → native promise fulfilled (with undefined) once settled === started; NEVER when any call returned a non-native value. */
export function createLedger() {
  const s = { started: 0, settled: 0, nonNative: 0, refusals: [], listeners: new Set() };
  const drained = () => s.settled === s.started && s.nonNative === 0;
  const notify = () => { for (const l of [...s.listeners]) { try { l(); } catch { /* contained */ } } };
  const ledger = freeze({
    snapshot: () => freeze({ started: s.started, settled: s.settled, nonNative: s.nonNative, refusals: freeze(s.refusals.map((r) => freeze({ ...r }))) }),
    whenDrained: () => new NativePromise((resolve) => {
      if (drained()) { resolve(); return; }
      const l = () => { if (drained()) { s.listeners.delete(l); resolve(); } };
      s.listeners.add(l);
    })
  });
  LEDGERS.set(ledger, { begin: () => { s.started += 1; notify(); }, settle: () => { s.settled += 1; notify(); }, nonNative: () => { s.nonNative += 1; },
    refusal: (key, code) => { s.refusals.push({ key, code }); }, listen: (l) => s.listeners.add(l) });
  return ledger;
}

/** code-only refusal facts via safe inspection; a forged / proxied / accessor `code` is never executed and simply not recorded */
function refusalCode(e) {
  try {
    if (e === null || typeof e !== "object" || isProxy(e) || getProto(e) !== REFUSAL_PROTO) return null;
    const d = getDesc(e, "code");
    return d && "value" in d && typeof d.value === "string" && REFUSAL_CODE_RE.test(d.value) ? d.value : null;
  } catch { return null; }
}

function wrapFn(fn, container, key, L) {
  return function wrappedExecutor(...args) {           // arguments are passed through untouched (never read)
    L.begin();
    let p;
    try { p = apply(fn, container, args); } catch (e) {
      const c = refusalCode(e); if (c) L.refusal(key, c);
      L.settle();
      throw e;                                           // the identical error object
    }
    if (!isNativePromise(p)) { L.nonNative(); L.settle(); return p; }
    sideHandle(p, () => L.settle(), (e) => { const c = refusalCode(e); if (c) L.refusal(key, c); L.settle(); });
    return p;                                            // the identical promise object
  };
}

/** wrapExecutors(executors, ledger) → frozen { ok:true, executors } | frozen { ok:false, code:'EXECUTORS_INVALID' }.
 *  Same key set; `label` passed through unchanged; `pricing` → { get, post } wrapped; every other key must be a function. */
export function wrapExecutors(executors, ledger) {
  const L = LEDGERS.get(ledger);
  try {
    if (!L || !isPlainObj(executors)) return freeze({ ok: false, code: "EXECUTORS_INVALID" });
    const d = getDescs(executors);
    const out = {};
    for (const k of ownKeys(d)) {
      if (typeof k !== "string" || !("value" in d[k]) || d[k].enumerable !== true) return freeze({ ok: false, code: "EXECUTORS_INVALID" });
      const v = d[k].value;
      if (k === "label") { out[k] = v; continue; }
      if (k === "pricing") {
        if (!isPlainObj(v)) return freeze({ ok: false, code: "EXECUTORS_INVALID" });
        const pd = dataKeys(v, ["get", "post"]);
        if (!pd || !isFn(pd.get.value) || !isFn(pd.post.value)) return freeze({ ok: false, code: "EXECUTORS_INVALID" });
        out[k] = freeze({ get: wrapFn(pd.get.value, v, "pricing.get", L), post: wrapFn(pd.post.value, v, "pricing.post", L) });
        continue;
      }
      if (!isFn(v)) return freeze({ ok: false, code: "EXECUTORS_INVALID" });
      out[k] = wrapFn(v, executors, k, L);
    }
    return freeze({ ok: true, executors: freeze(out) });
  } catch { return freeze({ ok: false, code: "EXECUTORS_INVALID" }); }
}

// ---- client tracking (contract §7.5) ----------------------------------------------------------------------------------------------
/** trackClient({ subscribe, unsubscribe, destroy, onLoss }) → frozen { ok:true, tracker } | frozen { ok:false, code }.
 *  The core supplies closures over ITS client (e.g. subscribe = (ev, h) => client.on(ev, h); destroy = () => client.release(true));
 *  this module never touches a client object. Events 'error' and 'end' while open → state 'lost', destroy ONCE, then onLoss() once.
 *  tracker: { destroy() → boolean (true iff this call destroyed), dispose() (removes both listeners once), state() → 'open'|'lost'|'destroyed' } */
export function trackClient(input) {
  try {
    if (!isPlainObj(input)) return freeze({ ok: false, code: "TRACK_INVALID" });
    const d = dataKeys(input, ["subscribe", "unsubscribe", "destroy", "onLoss"]);
    if (!d || !["subscribe", "unsubscribe", "destroy", "onLoss"].every((k) => isFn(d[k].value))) return freeze({ ok: false, code: "TRACK_INVALID" });
    const subscribe = d.subscribe.value; const unsubscribe = d.unsubscribe.value; const destroyFn = d.destroy.value; const onLoss = d.onLoss.value;
    let state = "open"; let destroyed = false; let disposed = false; let destroyFailures = 0;
    const doDestroy = () => { if (destroyed) return false; destroyed = true; try { apply(destroyFn, undefined, []); } catch { destroyFailures += 1; } return true; };
    const lost = () => { if (state !== "open") return; state = "lost"; doDestroy(); try { apply(onLoss, undefined, []); } catch { /* contained */ } };
    const hErr = () => lost();
    const hEnd = () => lost();
    try { apply(subscribe, undefined, ["error", hErr]); apply(subscribe, undefined, ["end", hEnd]); } catch {
      state = "lost"; doDestroy();
      try { apply(unsubscribe, undefined, ["error", hErr]); apply(unsubscribe, undefined, ["end", hEnd]); } catch { /* contained */ }
      return freeze({ ok: false, code: "TRACK_SUBSCRIBE_FAILED" });
    }
    const tracker = freeze({
      destroy: () => { const r = doDestroy(); if (r && state === "open") state = "destroyed"; return r; },
      dispose: () => {
        if (disposed) return; disposed = true;
        try { apply(unsubscribe, undefined, ["error", hErr]); } catch { /* contained */ }
        try { apply(unsubscribe, undefined, ["end", hEnd]); } catch { /* contained */ }
      },
      state: () => state,
      destroyFailures: () => destroyFailures
    });
    return freeze({ ok: true, tracker });
  } catch { return freeze({ ok: false, code: "TRACK_INVALID" }); }
}

// ---- lifecycle (contract §7.3, §7.5, §7.6) --------------------------------------------------------------------------------------
/** createLifecycle({ guard }) → frozen lifecycle. Throws TypeError('LIFECYCLE_INVALID') for a guard not made by createGuard. */
export function createLifecycle(input) {
  let guard;
  try { const d = isPlainObj(input) ? dataKeys(input, ["guard"]) : null; guard = d ? d.guard.value : null; } catch { guard = null; }
  if (!guard || !GUARDS.has(guard)) throw new TypeError("LIFECYCLE_INVALID");

  const s = { outstanding: "NONE", phase: null, tailObservable: true, dbFamily: false, stopCode: null, exclusion: "not_acquired",
    exclusionLost: false, lock: null, lockDestroyed: false, lockDestroyFailures: 0, lateClientsDestroyed: 0, finalizing: false,
    stepPromise: null, tailPromise: null, ledgers: new Set(), waiters: new Set() };
  let finalizeP = null;

  const drainedAll = () => [...s.ledgers].every((l) => { const x = l.snapshot(); return x.settled === x.started && x.nonNative === 0; });
  const quiescentNow = () => s.outstanding === "NONE" && drainedAll();
  const notify = () => { for (const w of [...s.waiters]) { try { w(); } catch { /* contained */ } } };

  function destroyLockOnce() {
    if (!s.lock || s.lockDestroyed) return;
    s.lockDestroyed = true;
    try { apply(s.lock.destroy, undefined, []); } catch { s.lockDestroyFailures += 1; }
  }
  function lateValueTransition(v) {
    // the step FULFILLED (possibly after its observation ended): adopt its native `late` (data property only) as the TAIL
    if (s.outstanding !== "STEP") return;
    let d;
    try { d = v !== null && typeof v === "object" && !isProxy(v) ? getDesc(v, "late") : undefined; } catch { d = { get: true }; }
    if (d === undefined) { s.outstanding = "NONE"; notify(); return; }
    if (!("value" in d) || !isNativePromise(d.value)) { s.outstanding = "TAIL"; s.tailObservable = false; notify(); return; }
    s.outstanding = "TAIL"; s.tailObservable = true; s.tailPromise = d.value;
    sideHandle(d.value, () => { if (s.outstanding === "TAIL" && s.tailObservable) { s.outstanding = "NONE"; notify(); } },
      () => { s.dbFamily = true; if (s.outstanding === "TAIL" && s.tailObservable) { s.outstanding = "NONE"; notify(); } });
    notify();
  }
  function rejectedTransition(ledger) {
    s.dbFamily = true;                                         // a step rejection may be a DB failure: disposal becomes destroy-only
    if (s.outstanding !== "STEP") return;
    if (ledger.snapshot().started > 0) { s.outstanding = "TAIL"; s.tailObservable = false; }   // tail possible but unobservable, forever
    else s.outstanding = "NONE";
    notify();
  }

  /** observeStep({ phase, deadline, start, ledger }) → Promise<frozen { kind, code?, value?, reason?, outstanding }>.
   *  Ownership begins BEFORE start runs: state is STEP from the instant start is invoked, the returned native promise is retained
   *  with settlement transitions attached before the guard observes it. kinds: not_started (start never called) | fulfilled |
   *  rejected | timeout | observation_failed. */
  async function observeStep(input2) {
    let phase, deadline, start, ledger;
    try {
      const d = isPlainObj(input2) ? dataKeys(input2, ["phase", "deadline", "start", "ledger"]) : null;
      if (!d) return freeze({ kind: "not_started", code: "LIFECYCLE_ARGUMENT_INVALID", outstanding: s.outstanding });
      ({ phase, deadline, start, ledger } = { phase: d.phase.value, deadline: d.deadline.value, start: d.start.value, ledger: d.ledger.value });
    } catch { return freeze({ kind: "not_started", code: "LIFECYCLE_ARGUMENT_INVALID", outstanding: s.outstanding }); }
    if (!STEP_PHASES.includes(phase) || !isFn(start) || !LEDGERS.has(ledger)) return freeze({ kind: "not_started", code: "LIFECYCLE_ARGUMENT_INVALID", outstanding: s.outstanding });
    if (s.finalizing) return freeze({ kind: "not_started", code: "LIFECYCLE_FINALIZING", outstanding: s.outstanding });
    if (s.outstanding !== "NONE") return freeze({ kind: "not_started", code: "LIFECYCLE_BUSY", outstanding: s.outstanding });
    s.ledgers.add(ledger);
    LEDGERS.get(ledger).listen(notify);
    const startOwned = () => {
      s.outstanding = "STEP"; s.phase = phase; s.tailObservable = true;
      let p;
      try { p = apply(start, undefined, []); } catch (e) { rejectedTransition(ledger); throw e; }
      if (!isNativePromise(p)) { s.outstanding = "TAIL"; s.tailObservable = false; notify(); return p; }
      s.stepPromise = p;
      sideHandle(p, (v) => lateValueTransition(v), () => rejectedTransition(ledger));
      return p;
    };
    const r = await guard.observe(deadline, startOwned);
    const base = { kind: r.kind, ...(r.code ? { code: r.code } : {}), ...(r.kind === "fulfilled" ? { value: r.value } : {}), ...(r.kind === "rejected" ? { reason: r.reason } : {}) };
    return freeze({ ...base, outstanding: s.outstanding });
  }

  /** observeTail(deadline) → Promise<frozen { kind:'settled'|'unobservable'|'timeout'|'not_started'|'observation_failed', code?, outstanding }> */
  async function observeTail(deadline) {
    if (s.outstanding === "NONE") return freeze({ kind: "settled", outstanding: "NONE" });
    if (s.outstanding !== "TAIL") return freeze({ kind: "not_started", code: "LIFECYCLE_NO_TAIL", outstanding: s.outstanding });
    if (!s.tailObservable) return freeze({ kind: "unobservable", outstanding: "TAIL" });
    const tail = s.tailPromise;
    const r = await guard.observe(deadline, () => tail);       // observes the EXISTING promise; no new work is started
    if (r.kind === "fulfilled" || r.kind === "rejected") return freeze({ kind: "settled", outstanding: s.outstanding });
    return freeze({ kind: r.kind, ...(r.code ? { code: r.code } : {}), outstanding: s.outstanding });
  }

  /** observeConnect(deadline, connect, destroyClient) → Promise<frozen { kind, client?, code? }>.
   *  In-time fulfilment hands the client to the caller. On timeout / post-start fault the late client (if it ever arrives) is passed to
   *  destroyClient exactly ONCE and never to anything else (never queried); a late rejection is swallowed. */
  async function observeConnect(deadline, connect, destroyClient) {
    if (!isFn(connect) || !isFn(destroyClient)) return freeze({ kind: "not_started", code: "LIFECYCLE_ARGUMENT_INVALID" });
    const r = await guard.observe(deadline, connect);
    if (r.kind === "fulfilled") return freeze({ kind: "fulfilled", client: r.value });
    let once = false;
    const kill = (c) => { if (once) return; once = true; try { apply(destroyClient, undefined, [c]); } catch { /* contained */ } s.lateClientsDestroyed += 1; };
    if (r.kind === "timeout" || (r.kind === "observation_failed" && r.op)) {
      if (r.kind === "observation_failed" && r.opState === "fulfilled") kill(r.value);
      else sideHandle(r.op, (c) => kill(c), () => { /* swallowed: no retry */ });
    }
    return freeze({ kind: r.kind, ...(r.code ? { code: r.code } : {}) });
  }

  /** attachLock({ unlock, destroy }) → boolean. unlock() → native Promise<boolean>; destroy() → local destruction (no SQL). Once only. */
  function attachLock(handle) {
    try {
      if (s.lock || s.exclusion !== "not_acquired" || !isPlainObj(handle)) return false;
      const d = dataKeys(handle, ["unlock", "destroy"]);
      if (!d || !isFn(d.unlock.value) || !isFn(d.destroy.value)) return false;
      s.lock = freeze({ unlock: d.unlock.value, destroy: d.destroy.value });
      s.exclusion = "held";
      return true;
    } catch { return false; }
  }
  /** lockLost() — the lock session errored / ended: exclusion 'lost', local destroy ONCE, never an unlock. Never cancels a step. */
  function lockLost() {
    if (s.exclusion !== "held") return;
    s.exclusion = "lost"; s.exclusionLost = true;
    destroyLockOnce();
  }

  /** finalize() → the SAME promise on every call (contract §7.6). Waits for quiescence with no deadline (may stay pending forever),
   *  cancels armed timers, then releases the lock: one bounded unlock on the non-DB path, destroy-only on the DB path. Never rejects. */
  function finalize() {
    if (finalizeP) return finalizeP;
    s.finalizing = true;
    finalizeP = (async () => {
      await new NativePromise((resolve) => {
        if (quiescentNow()) { resolve(); return; }
        const w = () => { if (quiescentNow()) { s.waiters.delete(w); resolve(); } };
        s.waiters.add(w);
      });
      const c = guard.cancelAll();
      let lockRelease;
      if (s.exclusion === "not_acquired") lockRelease = "not_acquired";
      else if (s.exclusion === "lost") lockRelease = "lost";
      else if (s.dbFamily || guard.broken()) { destroyLockOnce(); lockRelease = "destroyed"; s.exclusion = "released"; }
      else {
        const now = guard.now();
        const u = now.ok ? await guard.observe(now.value + LIMITS.UNLOCK_MS, () => apply(s.lock.unlock, undefined, [])) : notStarted(now.code);
        if (s.exclusion === "lost") lockRelease = "lost";
        else {
          destroyLockOnce(); s.exclusion = "released";
          if (u.kind === "fulfilled" && u.value === true) lockRelease = "unlocked";
          else if (u.kind === "timeout") lockRelease = "destroyed_after_unlock_timeout";
          else if (u.kind === "fulfilled" || u.kind === "rejected") { lockRelease = "destroyed_after_unlock_failure"; if (u.kind === "fulfilled" && u.value === false) s.exclusionLost = true; }
          else lockRelease = "destroyed";
        }
      }
      return freeze({ quiescence: "observed", lockRelease, exclusionLost: s.exclusionLost, lateClientsDestroyed: s.lateClientsDestroyed,
        timerCancelFailures: guard.cancelFailures(), timersCancelledAtDisposal: c.cancelled });
    })().catch(() => { destroyLockOnce(); return freeze({ quiescence: "observed", lockRelease: "destroyed", exclusionLost: s.exclusionLost,
      lateClientsDestroyed: s.lateClientsDestroyed, timerCancelFailures: guard.cancelFailures(), internalFault: true }); });
    return finalizeP;
  }

  return freeze({
    observeStep, observeTail, observeConnect, attachLock, lockLost, finalize,
    /** stop(code) → frozen { stopCode } — the FIRST valid code wins; later calls never replace it */
    stop: (code) => { if (s.stopCode === null && typeof code === "string" && CODE_RE.test(code)) s.stopCode = code; return freeze({ stopCode: s.stopCode }); },
    /** markDbFamily() — after a DB-family stop: disposal becomes destroy-only, no unlock SQL */
    markDbFamily: () => { s.dbFamily = true; },
    /** snapshot() → frozen flags at this instant */
    snapshot: () => freeze({ stopCode: s.stopCode, outstanding: s.outstanding, outstandingPhase: s.outstanding === "NONE" ? null : s.phase,
      tailObservable: s.tailObservable, dbFamily: s.dbFamily, exclusion: s.exclusion,
      exclusionLost: s.exclusionLost, finalizing: s.finalizing })
  });
}
