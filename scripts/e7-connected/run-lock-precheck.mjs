// scripts/e7-connected/run-lock-precheck.mjs — E7: LEAF module for the P3 read-only advisory-lock precheck.
//  * Extracted VERBATIM from run-r1-launcher.mjs (merged 609d22b) so the launcher can re-export it for compatibility
//    and a standalone report-only CLI can import ONLY this leaf — never the execution closure (abort executor,
//    transports, exchange, credential readers, pg/pool). This file has ZERO module imports.
//  * lockPrecheck takes an injected `pool` and timer `proc`; `freeze` / `Promise` / `Math` are language intrinsics.
//  * LOCK_KEY is defined here as the single source for the precheck. It MUST equal run-core.mjs LOCK_KEY; that is
//    drift-guarded by run-lock-precheck.test.mjs, which reads run-core.mjs as TEXT (it does not import the executor).
//  * Behaviour is byte-identical to the merged function. The one statement is a READ-ONLY pg_locks count that
//    acquires NO advisory lock and performs NO persistent mutation. No SQL or caller behaviour is changed here.
const freeze = Object.freeze;
export const LOCK_KEY = "e7-connected-runner";
export const LOCK_PRECHECK_SQL = "SELECT count(*)::int AS n FROM pg_catalog.pg_locks l"
  + " WHERE l.locktype = 'advisory' AND l.granted"
  + " AND l.database = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())"
  + " AND l.classid = ((pg_catalog.hashtext($1)::bigint + 4294967296) % 4294967296)::oid"
  + " AND l.objid = 0::oid AND l.objsubid = 2";
export const LOCK_PRECHECK_CONNECT_MS = 10_000;
export const LOCK_PRECHECK_QUERY_MS = 5_000;
/**
 * lockPrecheck(pool, { proc, K, signal }) → Promise<{ code }>, never rejects. code ∈ LOCK_PRECHECK_CLEAR | RUN_LOCK_PRESENT_BEFORE_START |
 *   LOCK_PRECHECK_UNAVAILABLE | LOCK_PRECHECK_INTERRUPTED. ONE client, ONE statement, destroyed exactly once (release(true)); a client that
 *   arrives late is destroyed on arrival; no SQL after a failed / unknown step; never unlocks / terminates / adopts; no error text kept.
 */
export function lockPrecheck(pool, { proc, K = 1, signal } = {}) {
  return new Promise((resolve) => {
    // settled: a result was resolved. failed: the client reported an error (observed failure vetoes any later clearance).
    let settled = false; let failed = false; let client = null; let timer = null; let destroyed = false;
    const aborted = () => !!(signal && signal.aborted);
    const stopped = () => settled || failed || aborted();                       // true => never start a connect / query
    const clearTimer = () => { if (timer !== null) { try { proc.clearTimer(timer); } catch { /* */ } timer = null; } };
    const destroy = (c) => { if (!c || (c === client && destroyed)) return; if (c === client) destroyed = true; try { c.removeListener?.("error", onErr); } catch { /* */ } try { c.release(true); } catch { /* */ } };
    const finish = (code) => {
      if (settled) return; settled = true;
      clearTimer();
      if (signal) { try { signal.removeEventListener("abort", onAbort); } catch { /* */ } }
      destroy(client);
      resolve(freeze({ code }));
    };
    function onAbort() { finish("LOCK_PRECHECK_INTERRUPTED"); }
    // an observed client error vetoes clearance and disposes exactly once, even if a queued query result arrives afterwards
    function onErr() { if (settled) return; failed = true; finish("LOCK_PRECHECK_UNAVAILABLE"); }
    // arm a bound; returns true only if it is safe to proceed. A timer-setup throw, or a stop that fires SYNCHRONOUSLY during
    // setTimer (e.g. an abort callback), finishes here and returns false — so no connect / query is started after a stop.
    const arm = (ms) => {
      let id;
      try { id = proc.setTimer(() => { timer = null; finish("LOCK_PRECHECK_UNAVAILABLE"); }, Math.max(0, ms / K)); }
      catch { finish("LOCK_PRECHECK_UNAVAILABLE"); return false; }
      if (settled) { try { proc.clearTimer(id); } catch { /* */ } timer = null; return false; }   // finished synchronously during setTimer
      timer = id; return true;
    };
    const stopCode = () => (aborted() ? "LOCK_PRECHECK_INTERRUPTED" : "LOCK_PRECHECK_UNAVAILABLE");
    if (aborted()) { finish("LOCK_PRECHECK_INTERRUPTED"); return; }
    if (signal) { try { signal.addEventListener("abort", onAbort, { once: true }); } catch { /* */ } }
    // ---- connect: arm, re-check AFTER timer setup and immediately BEFORE the connect call ----
    if (!arm(LOCK_PRECHECK_CONNECT_MS)) return;
    if (stopped()) { finish(stopCode()); return; }
    let p;
    try { p = Promise.resolve(pool.connect()); }
    catch { finish("LOCK_PRECHECK_UNAVAILABLE"); return; }
    p.then((c) => {
      if (stopped()) { destroy(c); return; }                                   // late arrival after a stop: dispose, never query
      client = c; try { c.on?.("error", onErr); } catch { /* */ }
      if (stopped()) { finish(stopCode()); return; }                           // an error could have fired on / before attach
      clearTimer();
      // ---- query: arm, re-check AFTER timer setup and immediately BEFORE the query call ----
      if (!arm(LOCK_PRECHECK_QUERY_MS)) return;
      if (stopped()) { finish(stopCode()); return; }
      let q;
      try { q = Promise.resolve(c.query(LOCK_PRECHECK_SQL, [LOCK_KEY])); }
      catch { finish("LOCK_PRECHECK_UNAVAILABLE"); return; }
      q.then((res) => {
        if (stopped()) return;                                                 // settled / observed failure / abort: never clear on a late result
        const rows = res && Array.isArray(res.rows) ? res.rows : null;
        const n = rows && rows.length === 1 && rows[0] && typeof rows[0] === "object" ? rows[0].n : undefined;
        if (!Number.isSafeInteger(n) || n < 0) { finish("LOCK_PRECHECK_UNAVAILABLE"); return; }
        finish(n === 0 ? "LOCK_PRECHECK_CLEAR" : "RUN_LOCK_PRESENT_BEFORE_START");
      }, () => finish("LOCK_PRECHECK_UNAVAILABLE"));
    }, () => finish("LOCK_PRECHECK_UNAVAILABLE"));
  });
}
