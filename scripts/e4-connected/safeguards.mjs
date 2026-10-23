// E4 connected-listing acceptance test — OFFLINE SAFEGUARD PRIMITIVES (no listing, currency, mapping or channel constants;
// no transport, credentials, env, file access or writes). Not wired into any runner. Target-specific guards are added only
// later, from values in an approved package.
//
// 1. observeSync: bounded, read-only polling of the Hostaway calendar for given nights until a state is seen STABLY
//    (N consecutive confirming reads) or a timeout/read cap is reached. A timeout or any doubt never implies anything:
//    the caller must not send a write because time passed. This observes Hostaway only; it is NOT Airbnb evidence
//    (Airbnb availability must be verified independently, e.g. owner checkpoints on Airbnb's own calendar).
// 2. evaluateCreateSideEffects: the explicit "expected conversation only" policy after ONE create — conversations for the
//    new reservation must be COMPLETE (bounded traversal) and contain exactly one id, tasks complete and empty, charges a
//    documented complete zero. Anything else (incl. UNKNOWN) is not acceptable. Message sends remain unobservable here.

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BLOCKING = ["reserved", "pending", "blocked", "hardBlock", "mreserved", "mblocked", "conflicted"];

/** One calendar response -> "blocked" | "open" | "mixed" | "unknown" for exactly the given nights. */
export function nightsState(resp, nights) {
  if (!isObj(resp) || resp.transportError || resp.httpStatus !== 200) return "unknown";
  const j = resp.json;
  if (!isObj(j) || j.status !== "success" || !Array.isArray(j.result)) return "unknown";
  const states = nights.map((date) => {
    const d = j.result.filter((x) => isObj(x) && x.date === date);
    if (d.length !== 1) return "unknown";
    const avail = d[0].isAvailable === 1 || d[0].isAvailable === true ? true : d[0].isAvailable === 0 || d[0].isAvailable === false ? false : null;
    if (d[0].status === "available" && avail === true) return "open";
    if (BLOCKING.includes(d[0].status) && avail === false) return "blocked";
    return "unknown";
  });
  if (states.includes("unknown")) return "unknown";
  return states.every((s) => s === "blocked") ? "blocked" : states.every((s) => s === "open") ? "open" : "mixed";
}

/**
 * opts: { readCalendar: async () => resp, nights: [YYYY-MM-DD...], expect: "blocked"|"open", intervalMs, timeoutMs, maxReads,
 *         confirmReads (default 2), startTimer: (ms) => { promise, cancel }, now: () => ms }
 * -> { code: "OBSERVED_STABLE" | "TIMEOUT" | "READ_CAP_REACHED" | "INVALID_OPTIONS", reads, history: [state...], observedAfterMs? }
 * One overall deadline = start + timeoutMs, enforced INCLUDING in-flight reads and waits: each read is raced against a
 * cancellable deadline timer that is ALWAYS cancelled after the race (no stray timer keeps a process alive or accumulates);
 * a read that settles at/after the deadline (or never settles) never counts; no read starts at/after the deadline.
 * Timers are injected (`startTimer`); `realTimer` below is the minimal setTimeout/clearTimeout implementation for
 * production. Tradeoff: a hung read is abandoned (its late result ignored), not cancelled — reads must be bounded by the
 * caller's transport timeout too.
 */
/** Minimal cancellable timer (the only timer use in this module). */
export function realTimer(ms) {
  let id; let done;
  const promise = new Promise((resolve) => { done = resolve; id = setTimeout(resolve, ms); });
  return { promise, cancel: () => { clearTimeout(id); done(); } };
}

export async function observeSync(opts = {}) {
  const { readCalendar, nights, expect, intervalMs, timeoutMs, maxReads, confirmReads = 2, startTimer, now } = opts;
  const valid = typeof readCalendar === "function" && Array.isArray(nights) && nights.length >= 1 && nights.length <= 31 && nights.every((d) => DATE.test(d)) &&
    new Set(nights).size === nights.length && ["blocked", "open"].includes(expect) && Number.isSafeInteger(intervalMs) && intervalMs >= 1000 &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= intervalMs && timeoutMs <= 2 * 3600 * 1000 && Number.isSafeInteger(maxReads) && maxReads >= 1 && maxReads <= 120 &&
    Number.isSafeInteger(confirmReads) && confirmReads >= 1 && confirmReads <= 5 && typeof startTimer === "function" && typeof now === "function";
  if (!valid) return { code: "INVALID_OPTIONS", reads: 0, history: [] };
  const start = now(); const deadline = start + timeoutMs; const history = []; let streak = 0;
  const TIMED_OUT = Symbol("timedOut");
  for (let reads = 1; reads <= maxReads; reads++) {
    const remaining = deadline - now();
    if (remaining <= 0) return { code: "TIMEOUT", reads: reads - 1, history };          // never start a read at/after the deadline
    let resp;
    const deadlineTimer = startTimer(remaining);
    try {
      resp = await Promise.race([Promise.resolve().then(() => readCalendar()), deadlineTimer.promise.then(() => TIMED_OUT)]);
    } catch { resp = { transportError: true }; }
    finally { deadlineTimer.cancel(); }                                                   // never leave the deadline timer pending
    if (resp === TIMED_OUT || now() >= deadline) return { code: "TIMEOUT", reads, history }; // hung or late: never counts
    const s = nightsState(resp, nights);
    history.push(s);
    streak = s === expect ? streak + 1 : 0;
    if (streak >= confirmReads) return { code: "OBSERVED_STABLE", reads, history, observedAfterMs: now() - start };
    if (reads === maxReads) return { code: "READ_CAP_REACHED", reads, history };
    if (now() + intervalMs >= deadline) return { code: "TIMEOUT", reads, history };   // the next read would start at/after it
    await startTimer(intervalMs).promise;
  }
  return { code: "READ_CAP_REACHED", reads: maxReads, history };
}

/**
 * Policy after ONE create. Inputs are the outputs of the reviewed readers: charges = evaluateSideEffectResponse(...).state,
 * conversations/tasks = traverseList(...) results ({ state, code, ids }).
 */
export function evaluateCreateSideEffects({ charges, conversations, tasks } = {}) {
  if (charges !== "zero") return { ok: false, code: charges === "present" ? "CHARGES_PRESENT" : "CHARGES_UNKNOWN" };
  if (!isObj(conversations) || conversations.state !== "complete" || !Array.isArray(conversations.ids)) return { ok: false, code: "CONVERSATIONS_UNKNOWN" };
  if (!isObj(tasks) || tasks.state !== "complete" || !Array.isArray(tasks.ids)) return { ok: false, code: "TASKS_UNKNOWN" };
  if (tasks.ids.length !== 0) return { ok: false, code: "TASKS_PRESENT" };
  if (conversations.ids.length === 0) return { ok: false, code: "EXPECTED_CONVERSATION_ABSENT" };
  if (conversations.ids.length > 1) return { ok: false, code: "MORE_THAN_ONE_CONVERSATION" };
  return { ok: true, code: "EXPECTED_SINGLE_CONVERSATION_ONLY", conversationId: conversations.ids[0], messagesObservable: false };
}
