// lib/booking-db/mirror-transport.js — ISOLATED executors / transports for the mirror worker (OFFLINE; ROOT GO 5884739645). Not imported by any route,
// worker default, runner or workflow. Builds EXACTLY the MIRROR_EXECUTOR_KEYS from injected primitives; never reads process.env, never logs a header,
// token or raw provider body; every reply is reduced to { httpStatus, json } (json null when unparsable) — codes only beyond that.
//
//   * Hostaway: GET /v1/reservations/{id}, GET /v1/guestPayments/charges?reservationId&limit, POST /v1/guestPayments/charges/{rid}/{och}/refund.
//     The POST is the ONLY write and is wire-limited to ONE per transport instance: the counter moves BEFORE fetch; a second POST throws
//     MIRROR_WIRE_LIMIT without touching the network. The body is the worker's field-exact request body, serialized once, unchanged.
//   * Stripe: the two READS (retrieveAccount, retrievePaymentIntent) through an injected client that exposes exactly those two methods.
//   * `combineMirrorExecutors` refuses any extra / missing key so the worker gate sees exactly MIRROR_EXECUTOR_KEYS.
import { MIRROR_EXECUTOR_KEYS } from "./mirror-worker.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const HOST_RE = /^https:\/\/[a-z0-9.-]+$/;
const PATH_RE = /^\/v1\/[A-Za-z0-9/_-]{1,200}$/;
export class MirrorTransportError extends Error { constructor(code) { super(code); this.code = code; } }

/**
 * buildHostawayMirrorExecutors({ fetchImpl, baseUrl, bearer, maxPosts = 1 })
 *   fetchImpl(url, init) -> Response-like { status, text() }; bearer() -> the token string (read at call time, never stored here, never logged).
 *   -> { retrieveReservation, listOfflineCharges, refundOfflineCharge, counts }
 */
export function buildHostawayMirrorExecutors({ fetchImpl, baseUrl, bearer, maxPosts = 1 } = {}) {
  if (typeof fetchImpl !== "function") throw new MirrorTransportError("FETCH_REQUIRED");
  if (typeof baseUrl !== "string" || !HOST_RE.test(baseUrl)) throw new MirrorTransportError("BASE_URL_INVALID");
  if (typeof bearer !== "function") throw new MirrorTransportError("BEARER_REQUIRED");
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 0 || maxPosts > 1) throw new MirrorTransportError("MAX_POSTS_INVALID");
  const counts = { gets: 0, posts: 0 };
  const call = async (req, { signal } = {}, { write = false } = {}) => {
    if (!isObj(req) || typeof req.path !== "string" || !PATH_RE.test(req.path)) throw new MirrorTransportError("REQUEST_PATH_INVALID");
    if (req.method !== (write ? "POST" : "GET")) throw new MirrorTransportError("REQUEST_METHOD_INVALID");
    const q = isObj(req.query) ? Object.entries(req.query) : [];
    for (const [k, v] of q) if (!/^[A-Za-z]{1,40}$/.test(k) || !(typeof v === "string" || Number.isSafeInteger(v))) throw new MirrorTransportError("REQUEST_QUERY_INVALID");
    const qs = q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}` : "";
    let body;
    if (write) {
      if (!isObj(req.body)) throw new MirrorTransportError("REQUEST_BODY_INVALID");
      body = JSON.stringify(req.body);
      if (counts.posts >= maxPosts) throw new MirrorTransportError("MIRROR_WIRE_LIMIT");
      counts.posts += 1;                                                              // BEFORE the transport call: never two POSTs from one instance
    } else counts.gets += 1;
    const token = bearer();
    if (typeof token !== "string" || token.length < 8) throw new MirrorTransportError("BEARER_INVALID");
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${req.path}${qs}`, { method: req.method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) },
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
    retrieveReservation: (req, o) => call(req, o),
    listOfflineCharges: (req, o) => call(req, o),
    refundOfflineCharge: (req, o) => call(req, o, { write: true }),
    counts
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
