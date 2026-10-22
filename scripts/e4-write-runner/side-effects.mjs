// E4 happy-path — reservation-scoped SIDE-EFFECT reader (OFFLINE scaffold; counts/states only).
//
// Used as the happy-path runner's injected `sideEffectProbe`. For the single test reservation it reads three
// documented lists through the SAME injected transport (official reference api.hostaway.com/documentation, read
// 2026-10-22):
//   GET /v1/guestPayments/charges?reservationId=  "Get guest charges list": reservationId (int) filter; limit defaults
//       to 100 (cap 500); "count is the total number of matching charges, ignoring limit and offset"; items carry
//       reservationId. => a COMPLETE count is provable.
//   GET /v1/conversations?reservationId=          "Retrieve a conversations list": reservationId filter; items carry
//       reservationId (documented type string). No list envelope, count or default limit is documented.
//   GET /v1/tasks?reservationId=                  "Retrieve tasks list": reservationId filter; the example shows only
//       { status, result } (no count).
// For conversations and tasks a complete count is NOT provable, so this reader never reports one: it can only
// certify ZERO (success envelope, an EMPTY first page for a filter it sent) or report PRESENT / UNKNOWN. Any
// non-empty page is a signal (the run stops) — completeness is irrelevant once something is present.
// Every item on a page must carry this reservation's id, otherwise the filter is treated as NOT applied (UNKNOWN).
// Nothing from an item (titles, messages, amounts, names, emails, statuses) is ever copied.
//
// Probe contract (happy-path.mjs): returns exactly { signals: [] } only when all three lists are certified zero;
// { signals: [codes] } when anything is present; otherwise { unknown: [codes] } (the runner halts on both).

import { E4_TEST_LISTING_ID } from "./runner.mjs";

export const SIDE_EFFECT_PAGE_LIMIT = 100;
export const SIDE_EFFECT_MAX_PROBES = 2;            // after the create and after the cancel
export const SIDE_EFFECT_SOURCES = Object.freeze([
  Object.freeze({ name: "CHARGES", path: "/guestPayments/charges", completeCountDocumented: true }),
  Object.freeze({ name: "CONVERSATIONS", path: "/conversations", completeCountDocumented: false }),
  Object.freeze({ name: "TASKS", path: "/tasks", completeCountDocumented: false })
]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const sameId = (v, id) => v === id || (typeof v === "string" && /^[1-9]\d{0,15}$/.test(v) && Number(v) === id);

/** The fixed read for one source. Only the validated reservation id varies. */
export function sideEffectRequest(source, reservationId) {
  return Object.freeze({ method: "GET", path: source.path,
    query: Object.freeze({ reservationId, limit: SIDE_EFFECT_PAGE_LIMIT, offset: 0 }) });
}

/** -> { source, state: "zero" | "present" | "unknown", code } (codes only). */
export function evaluateSideEffectResponse(source, resp, reservationId) {
  const out = (state, code) => Object.freeze({ source: source.name, state, code: `${source.name}_${code}` });
  if (!isObj(resp) || resp.transportError) return out("unknown", "TRANSPORT_UNCERTAIN");
  if (resp.httpStatus !== 200) return out("unknown", "HTTP_NOT_OK");
  const j = resp.json;
  if (!isObj(j) || j.status !== "success" || !Array.isArray(j.result)) return out("unknown", "MALFORMED");
  const items = j.result;
  if (items.length > SIDE_EFFECT_PAGE_LIMIT) return out("unknown", "PAGE_OVER_LIMIT");
  if (!items.every((it) => isObj(it) && sameId(it.reservationId, reservationId))) return out("unknown", "FILTER_NOT_APPLIED");
  const hasCount = Object.prototype.hasOwnProperty.call(j, "count") && j.count !== null;
  if (hasCount && !(Number.isSafeInteger(j.count) && j.count >= 0)) return out("unknown", "COUNT_INVALID");
  if (source.completeCountDocumented) {
    if (!hasCount) return out("unknown", "COUNT_MISSING");
    if (j.count === 0 && items.length === 0) return out("zero", "NONE");
    if (j.count > 0 || items.length > 0) {
      if (j.count < items.length) return out("unknown", "COUNT_INCONSISTENT");
      return out("present", "PRESENT");
    }
  }
  if (items.length > 0) return out("present", "PRESENT");
  if (hasCount && j.count > 0) return out("unknown", "COUNT_INCONSISTENT"); // empty page but a positive count
  return out("zero", "NONE");
}

/**
 * Build the probe. `send` is the injected transport's send (single attempt). At most SIDE_EFFECT_MAX_PROBES calls ×
 * 3 reads per run; a call without exactly one valid reservation id on listing 606998 sends nothing and is UNKNOWN.
 */
export function createSideEffectProbe({ send } = {}) {
  if (typeof send !== "function") throw new TypeError("send required");
  let calls = 0;
  let reads = 0;
  async function probe(input) {
    calls++;
    if (calls > SIDE_EFFECT_MAX_PROBES) return Object.freeze({ unknown: Object.freeze(["PROBE_BUDGET_EXHAUSTED"]) });
    const ids = isObj(input) && Array.isArray(input.reservationIds) ? input.reservationIds : null;
    if (!isObj(input) || input.listingId !== E4_TEST_LISTING_ID || !ids || ids.length !== 1 || !isPosInt(ids[0])) {
      return Object.freeze({ unknown: Object.freeze(["PROBE_SCOPE_INVALID"]) });
    }
    const id = ids[0];
    const results = [];
    for (const source of SIDE_EFFECT_SOURCES) {
      reads++;
      let resp;
      try { resp = await send(sideEffectRequest(source, id)); } catch { resp = { transportError: true }; }
      results.push(evaluateSideEffectResponse(source, resp, id));
    }
    const present = results.filter((r) => r.state === "present").map((r) => r.code);
    const unknown = results.filter((r) => r.state === "unknown").map((r) => r.code);
    if (present.length) return Object.freeze({ signals: Object.freeze(present) });
    if (unknown.length) return Object.freeze({ unknown: Object.freeze(unknown) });
    return Object.freeze({ signals: Object.freeze([]) });
  }
  return Object.freeze({ probe, usage: () => Object.freeze({ calls, reads }) });
}
