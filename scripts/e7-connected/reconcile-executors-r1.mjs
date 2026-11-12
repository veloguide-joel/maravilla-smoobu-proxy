// scripts/e7-connected/reconcile-executors-r1.mjs — E7 N2 reconcile-only runner (R-B, Step A): STRICT GET-ONLY Hostaway executors for the
// accepted reservation worker. NEW module (the existing "reservation-recovery" phase still permits pricing; it is NOT broadened or reused).
//   * lookupPage: exactly GET /reservations with the accepted lookup query for ONE bound listing + arrival date (+ an opaque positive afterId
//     cursor), forwarded to the accepted transport as /v1/reservations.
//   * retrieveReservation: exactly GET /reservations/<ONE bound reservation id>, empty query.
//   * createReservation and pricing.get / pricing.post exist ONLY because the accepted worker gate requires the key set: every call is
//     REFUSED before any transport, recorded as a violation, and stops the session. No other method, path, query or URL can be built.
//   * Every reply is observed: the FIRST non-200 (401 / 403 → AUTH_REFUSED, 429 → RATE_LIMITED, 404 → NOT_FOUND_404, 5xx → PROVIDER_UNAVAILABLE,
//     other → HTTP_UNEXPECTED) or transport failure / bad reply shape (UNREADABLE) sets `stop`; the caller ends the session at the next boundary.
//   * A hard per-session GET cap; after `stop` or the cap every further call refuses before the transport.
//   * Deadlines: each GET is bounded by min(callTimeoutMs, remaining session time) — an AbortSignal for the transport AND a hard bound on the
//     awaited reply: a reply that never settles or ignores the abort is DROPPED (never handed to the worker, so it can cause no late DB write;
//     the read-only network call may still finish in the background, its result discarded). No GET starts once the session deadline passed.
// NOT part of any reviewed closure; no provider write is representable here.
// No adapter import (adapter importers are an exact reviewed allowlist): these two accepted values are restated here and pinned EQUAL to
// the accepted Hostaway adapter's LOOKUP_PAGE_LIMIT / DIRECT_CHANNEL_ID by test/db/e7-reconcile-r1.test.mjs RB11.
export const LOOKUP_PAGE_LIMIT = 100;
export const DIRECT_CHANNEL_ID = 2000;

const freeze = Object.freeze;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const keysEq = (o, ks) => isObj(o) && Object.keys(o).length === ks.length && ks.every((k) => Object.hasOwn(o, k));
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const ID_RE = /^[1-9][0-9]{0,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LOOKUP_BASE_KEYS = Object.freeze(["arrivalEndDate", "arrivalStartDate", "channelId", "includeResources", "limit", "listingId"]);
export class ReconcileRefusal extends Error { constructor(code) { super("RECONCILE_EXECUTOR_REFUSED"); this.name = "ReconcileRefusal"; this.code = code; } }

/**
 * createReconcileExecutorsR1({ binding: { listingId, arrivalDate, reservationId }, send, maxGets })
 *   send = the ACCEPTED Hostaway transport send(request, { signal }) → { httpStatus, json }
 * → { ok:true, executors, observe } | { ok:false, code }
 *   observe.gets / .stop / .violations / .log ([{ path, httpStatus|null }]) — read-only views for the core
 */
export function createReconcileExecutorsR1({ binding, send, maxGets, remainingMs, callTimeoutMs = 10_000 } = {}) {
  if (!isObj(binding) || !isPosInt(binding.listingId) || typeof binding.arrivalDate !== "string" || !DATE_RE.test(binding.arrivalDate)
      || typeof binding.reservationId !== "string" || !ID_RE.test(binding.reservationId)) return freeze({ ok: false, code: "BINDING_INVALID" });
  if (typeof send !== "function") return freeze({ ok: false, code: "TRANSPORT_INVALID" });
  if (!Number.isSafeInteger(maxGets) || maxGets < 1 || maxGets > 40) return freeze({ ok: false, code: "BUDGET_INVALID" });
  if (typeof remainingMs !== "function" || !Number.isSafeInteger(callTimeoutMs) || callTimeoutMs < 1 || callTimeoutMs > 30_000) return freeze({ ok: false, code: "DEADLINE_INVALID" });
  const b = freeze({ ...binding });
  const st = { gets: 0, stop: null, violations: [], log: [] };
  const setStop = (code, httpStatus = null) => { if (!st.stop) st.stop = freeze({ code, httpStatus }); };
  const refuse = (code) => { st.violations.push(code); setStop("EXECUTOR_REFUSED"); throw new ReconcileRefusal(code); };
  const signalOf = (opts) => { if (!keysEq(opts, ["signal"]) && !(isObj(opts) && Object.keys(opts).length === 0)) refuse("OPTIONS"); return opts.signal; };
  async function get(path, query, opts) {
    const outer = signalOf(opts);
    if (st.stop) refuse("SESSION_STOPPED");
    const left = Math.floor(remainingMs());
    if (!(left > 0)) { setStop("SESSION_DEADLINE"); throw new ReconcileRefusal("SESSION_DEADLINE"); }
    if (st.gets >= maxGets) { setStop("GET_BUDGET_EXHAUSTED"); throw new ReconcileRefusal("GET_BUDGET_EXHAUSTED"); }
    st.gets += 1;
    const bound = Math.min(callTimeoutMs, left);
    const ac = new AbortController();
    const signal = outer ? AbortSignal.any([outer, ac.signal]) : ac.signal;
    let timer = null; let hard = null;
    let reply;
    try {
      const call = Promise.resolve().then(() => send(freeze({ method: "GET", path: `/v1${path}`, query: freeze({ ...query }) }), freeze({ signal })));
      call.catch(() => {});                                                    // a dropped late rejection is never unhandled
      timer = setTimeout(() => ac.abort(), bound);
      const expire = new Promise((_, rej) => { hard = setTimeout(() => rej(Object.assign(new Error("CALL_TIMEOUT"), { code: "CALL_TIMEOUT" })), bound + 50); });
      reply = await Promise.race([call, expire]);                              // READ-ONLY call; a late result is dropped, never passed on
    } catch (e) {
      st.log.push(freeze({ path, httpStatus: null })); setStop(e && e.code === "CALL_TIMEOUT" ? "CALL_TIMEOUT" : "UNREADABLE"); throw e;
    } finally { clearTimeout(timer); clearTimeout(hard); }
    if (!keysEq(reply, ["httpStatus", "json"]) || !Number.isSafeInteger(reply.httpStatus)) { st.log.push(freeze({ path, httpStatus: null })); setStop("UNREADABLE"); return reply; }
    const s = reply.httpStatus;
    st.log.push(freeze({ path, httpStatus: s }));
    if (s !== 200) setStop(s === 401 || s === 403 ? "AUTH_REFUSED" : s === 429 ? "RATE_LIMITED" : s === 404 ? "NOT_FOUND_404" : s >= 500 ? "PROVIDER_UNAVAILABLE" : "HTTP_UNEXPECTED", s);
    return reply;
  }
  const executors = freeze({
    lookupPage: async (req, opts) => {
      if (!keysEq(req, ["method", "path", "query"]) || req.method !== "GET" || req.path !== "/reservations") refuse("LOOKUP_REQUEST");
      const q = req.query;
      const hasCursor = isObj(q) && Object.hasOwn(q, "afterId");
      if (!(keysEq(q, LOOKUP_BASE_KEYS) || (hasCursor && keysEq(q, [...LOOKUP_BASE_KEYS, "afterId"])))) refuse("LOOKUP_QUERY");
      if (q.listingId !== b.listingId || q.channelId !== DIRECT_CHANNEL_ID || q.arrivalStartDate !== b.arrivalDate || q.arrivalEndDate !== b.arrivalDate
          || q.limit !== LOOKUP_PAGE_LIMIT || q.includeResources !== 1 || (hasCursor && !isPosInt(q.afterId))) refuse("LOOKUP_QUERY_SCOPE");
      return get("/reservations", q, opts);
    },
    retrieveReservation: async (req, opts) => {
      if (!keysEq(req, ["method", "path", "query"]) || req.method !== "GET" || req.path !== `/reservations/${b.reservationId}`
          || !keysEq(req.query, [])) refuse("RETRIEVE_REQUEST");
      return get(`/reservations/${b.reservationId}`, {}, opts);
    },
    createReservation: async () => refuse("CREATE_NOT_ALLOWED"),
    pricing: freeze({ get: async () => refuse("PRICING_NOT_ALLOWED"), post: async () => refuse("PRICING_NOT_ALLOWED") })
  });
  const observe = freeze({ get gets() { return st.gets; }, get stop() { return st.stop; }, get violations() { return [...st.violations]; }, get log() { return [...st.log]; } });
  return freeze({ ok: true, executors, observe });
}
