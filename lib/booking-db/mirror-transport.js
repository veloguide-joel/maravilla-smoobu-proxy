// lib/booking-db/mirror-transport.js — ISOLATED executors / transports for the mirror worker (OFFLINE; ROOT GO 5884739645; rev2 ROOT HOLD 5885005598 F3).
// Not imported by any route, worker default, runner or workflow. Builds EXACTLY the MIRROR_EXECUTOR_KEYS from injected primitives; never reads
// process.env, never logs a header, token or raw provider body; every reply is reduced to { httpStatus, json } (json null when unparsable) — codes only.
//
//   * Hostaway executors are BOUND at construction to ONE validated, immutable per-intent binding { intentId, reservationId, offlineChargeId,
//     amountMinor, currency }: every executor accepts exactly ONE request shape (method, path, query, body) derived from that binding and refuses any
//     deviation BEFORE fetch (REQUEST_TARGET_FORBIDDEN / REQUEST_BODY_FORBIDDEN): a foreign reservation, another charge, an extra query key or body
//     field, another amount / title (marker) / breakdown flag. Protected reservations are refused at construction.
//       - retrieveReservation : GET  /v1/reservations/{reservationId}                                   query {}
//       - listOfflineCharges  : GET  /v1/guestPayments/charges                                          query { reservationId, limit: LIST_LIMIT }
//       - refundOfflineCharge : POST /v1/guestPayments/charges/{reservationId}/{offlineChargeId}/refund query {}
//                               body EXACTLY { title: mirrorTitle(intentId), amount: exactAmount(amountMinor), isIncludeInPriceBreakdown: 0 }
//     The POST is the ONLY write and is wire-limited to ONE per transport instance by a PRIVATE monotonic counter (closure state, never exposed for
//     writing): the counter moves BEFORE fetch; a second / concurrent POST throws MIRROR_WIRE_LIMIT without touching the network. `counts()` returns a
//     frozen read-only snapshot. A pre-aborted signal is refused (ABORTED) before the counter and before fetch.
//   * Stripe: the two READS (retrieveAccount, retrievePaymentIntent) through an injected client that exposes exactly those two methods.
//   * `combineMirrorExecutors` refuses any extra / missing key so the worker gate sees exactly MIRROR_EXECUTOR_KEYS.
import { MIRROR_EXECUTOR_KEYS } from "./mirror-worker.js";
import { MIRROR_LIST_LIMIT, MIRROR_INCLUDE_IN_PRICE_BREAKDOWN, mirrorTitle } from "../checkout/mirror-proof.js";
import { isCanonicalId, exactAmount } from "../checkout/offline-charge-proof.js";
import { isProtectedReservationId } from "../checkout/compensation-proof.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const HOST_RE = /^https:\/\/[a-z0-9.-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING_KEYS = Object.freeze(["amountMinor", "currency", "intentId", "offlineChargeId", "reservationId"]);
const BODY_KEYS = Object.freeze(["amount", "isIncludeInPriceBreakdown", "title"]);
const sortedKeys = (o) => Object.keys(o).sort();
const sameKeys = (o, keys) => isObj(o) && sortedKeys(o).join(",") === [...keys].sort().join(",");
export class MirrorTransportError extends Error { constructor(code) { super(code); this.code = code; } }

/** the validated, frozen binding: ids canonical, not protected, offline charge ≠ reservation, exact positive USD money; derived exact targets */
function validateBinding(b) {
  if (b === undefined || b === null) throw new MirrorTransportError("BINDING_REQUIRED");
  if (!sameKeys(b, BINDING_KEYS)) throw new MirrorTransportError("BINDING_SHAPE");
  if (typeof b.intentId !== "string" || !UUID_RE.test(b.intentId)) throw new MirrorTransportError("BINDING_INTENT_INVALID");
  if (typeof b.reservationId !== "string" || !isCanonicalId(b.reservationId)) throw new MirrorTransportError("BINDING_RESERVATION_INVALID");
  if (isProtectedReservationId(b.reservationId)) throw new MirrorTransportError("BINDING_RESERVATION_PROTECTED");
  if (typeof b.offlineChargeId !== "string" || !isCanonicalId(b.offlineChargeId)) throw new MirrorTransportError("BINDING_OFFLINE_CHARGE_INVALID");
  if (b.offlineChargeId === b.reservationId) throw new MirrorTransportError("BINDING_OFFLINE_CHARGE_IS_RESERVATION");
  const amount = Number.isSafeInteger(b.amountMinor) && b.amountMinor > 0 ? exactAmount(b.amountMinor) : null;
  if (amount === null) throw new MirrorTransportError("BINDING_AMOUNT_INVALID");
  if (b.currency !== "USD") throw new MirrorTransportError("BINDING_CURRENCY_NOT_APPROVED");
  return Object.freeze({ intentId: b.intentId, reservationId: b.reservationId, offlineChargeId: b.offlineChargeId, amountMinor: b.amountMinor, currency: b.currency,
    amount, title: mirrorTitle(b.intentId), listPath: "/v1/guestPayments/charges", reservationPath: `/v1/reservations/${b.reservationId}`,
    refundPath: `/v1/guestPayments/charges/${b.reservationId}/${b.offlineChargeId}/refund` });
}
/** exact request shape fence (BEFORE any counter / fetch): the one bound target per executor */
function fence(req, { method, path, query, body }) {
  if (!isObj(req) || !sameKeys(req, body ? ["body", "method", "path", "query"] : ["method", "path", "query"])) throw new MirrorTransportError("REQUEST_SHAPE_INVALID");
  if (req.method !== method) throw new MirrorTransportError("REQUEST_METHOD_INVALID");
  if (req.path !== path || !isObj(req.query) || !sameKeys(req.query, Object.keys(query)) || Object.keys(query).some((k) => req.query[k] !== query[k])) throw new MirrorTransportError("REQUEST_TARGET_FORBIDDEN");
  if (body) { if (!isObj(req.body) || !sameKeys(req.body, BODY_KEYS) || BODY_KEYS.some((k) => req.body[k] !== body[k])) throw new MirrorTransportError("REQUEST_BODY_FORBIDDEN"); }
}

/**
 * buildHostawayMirrorExecutors({ fetchImpl, baseUrl, bearer, binding, maxPosts = 1 })
 *   fetchImpl(url, init) -> Response-like { status, text() }; bearer() -> the token string (read at call time, never stored here, never logged);
 *   binding = { intentId, reservationId, offlineChargeId, amountMinor, currency } (validated, frozen; see validateBinding).
 *   -> frozen { retrieveReservation, listOfflineCharges, refundOfflineCharge, counts(), binding }
 */
export function buildHostawayMirrorExecutors({ fetchImpl, baseUrl, bearer, binding, maxPosts = 1 } = {}) {
  if (typeof fetchImpl !== "function") throw new MirrorTransportError("FETCH_REQUIRED");
  if (typeof baseUrl !== "string" || !HOST_RE.test(baseUrl)) throw new MirrorTransportError("BASE_URL_INVALID");
  if (typeof bearer !== "function") throw new MirrorTransportError("BEARER_REQUIRED");
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 0 || maxPosts > 1) throw new MirrorTransportError("MAX_POSTS_INVALID");
  const B = validateBinding(binding);
  const TARGETS = Object.freeze({
    retrieveReservation: Object.freeze({ method: "GET", path: B.reservationPath, query: Object.freeze({}) }),
    listOfflineCharges: Object.freeze({ method: "GET", path: B.listPath, query: Object.freeze({ reservationId: B.reservationId, limit: MIRROR_LIST_LIMIT }) }),
    refundOfflineCharge: Object.freeze({ method: "POST", path: B.refundPath, query: Object.freeze({}), body: Object.freeze({ title: B.title, amount: B.amount, isIncludeInPriceBreakdown: MIRROR_INCLUDE_IN_PRICE_BREAKDOWN }) })
  });
  let gets = 0; let posts = 0;                                                         // PRIVATE monotonic counters (closure state; never exposed for writing)
  const call = async (req, { signal } = {}, target) => {
    fence(req, target);                                                                // exact target / body BEFORE anything else
    if (signal && signal.aborted) throw new MirrorTransportError("ABORTED");          // a pre-aborted call never counts and never reaches fetch
    const write = !!target.body;
    const q = Object.entries(target.query);
    const qs = q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}` : "";
    let body;
    if (write) {
      if (posts >= maxPosts) throw new MirrorTransportError("MIRROR_WIRE_LIMIT");
      posts += 1;                                                                      // BEFORE the transport call: never two POSTs from one instance
      body = JSON.stringify(target.body);                                              // the bound body (field-identical to the fenced request body)
    } else gets += 1;
    const token = bearer();
    if (typeof token !== "string" || token.length < 8) throw new MirrorTransportError("BEARER_INVALID");
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${target.path}${qs}`, { method: target.method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
        ...(write ? { body } : {}), signal });
    } catch (e) {
      if (signal && signal.aborted) throw new MirrorTransportError("ABORTED");
      throw new MirrorTransportError("TRANSPORT_FAILED");                             // the raw error never leaves the transport
    }
    const status = Number(res && res.status);
    let json = null;
    try { const text = typeof res.text === "function" ? await res.text() : ""; json = text ? JSON.parse(text) : null; } catch { json = null; }
    return Object.freeze({ httpStatus: Number.isSafeInteger(status) ? status : 0, json });
  };
  return Object.freeze({
    retrieveReservation: (req, o) => call(req, o, TARGETS.retrieveReservation),
    listOfflineCharges: (req, o) => call(req, o, TARGETS.listOfflineCharges),
    refundOfflineCharge: (req, o) => call(req, o, TARGETS.refundOfflineCharge),
    counts: () => Object.freeze({ gets, posts }),                                      // read-only diagnostics snapshot
    binding: B
  });
}

/** buildStripeMirrorExecutors({ client }) — client exposes retrieveAccount(opts) and retrievePaymentIntent(id, params, opts) (reads only). */
export function buildStripeMirrorExecutors({ client } = {}) {
  if (!isObj(client) || typeof client.retrieveAccount !== "function" || typeof client.retrievePaymentIntent !== "function") throw new MirrorTransportError("STRIPE_CLIENT_INVALID");
  return Object.freeze({
    retrieveAccount: (o) => client.retrieveAccount(o),
    retrievePaymentIntent: (id, params, o) => client.retrievePaymentIntent(id, params, o)
  });
}
/** exactly MIRROR_EXECUTOR_KEYS, nothing else (the gate re-checks) */
export function combineMirrorExecutors(stripeExecs, hostawayExecs) {
  const out = {};
  for (const k of MIRROR_EXECUTOR_KEYS) {
    const f = (stripeExecs && stripeExecs[k]) || (hostawayExecs && hostawayExecs[k]);
    if (typeof f !== "function") throw new MirrorTransportError(`EXECUTOR_MISSING_${k}`);
    out[k] = f;
  }
  return Object.freeze(out);
}
