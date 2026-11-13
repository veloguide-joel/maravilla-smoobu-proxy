// lib/checkout/mirror-proof.js — E7 recorded TEST cleanup: PURE proofs for the Hostaway offline-refund MIRROR (0021 foundation; ROOT GO 5884739645).
//
// Pure functions only: no I/O, no clock of their own, no provider semantics beyond the official refund-offline-charge facts (ROOT-read):
// POST /v1/guestPayments/charges/{reservationId}/{chargeId}/refund with a mandatory `title` and a POSITIVE `amount`, optional
// `isIncludeInPriceBreakdown` (ROOT decision: 0); the provider stores the refund as a SEPARATE `type refund` row with a NEGATIVE amount and a typed
// `refundInfo { id, chargeId: <refund row id>, refundedChargeId: <original> }`; the reply carries `result.id` and `result.refundInfo`. Anything the
// facts do not state (HTTP code, list inclusion, idempotency) is NOT assumed: a reply is never proof, the confirming LIST decides, and everything
// missing / untyped / ambiguous fails CLOSED.
//
// Id vocabulary (packet §1, never interchanged): offlineChargeId = the ORIGINAL Hostaway charge row (intents.offline_charge_id, the recording's
// result_ref); offlineRefundId = the Hostaway REFUND row id (the mirror op's result_ref); stripeChargeId / stripeRefundId belong to the Stripe legs.
import { unwrapEnvelope, amountToMinor } from "../hostaway-reservations.js";
import { isCanonicalId, providerIdToCanonical, exactAmount, classifyTitle, offlineChargeMarker, offlineChargeTitle, LIST_LIMIT, APPROVED_PAYMENT_METHODS,
  freshnessRefusal } from "./offline-charge-proof.js";
import { STATES as S } from "./intent-state.js";

export const MIRROR_PROOF_VERSION = "offline-refund-proof-v1";
export const MIRROR_OP = "hostaway.refund_offline_charge";
export const MIRROR_MARKER_PREFIX = "mvochr1-";
export const MIRROR_TITLE_PREFIX = "maraVilla refund ";
export const MIRROR_INCLUDE_IN_PRICE_BREAKDOWN = 0;                                  // ROOT decision (packet §11, 5884066227)
export const MIRROR_LIST_LIMIT = LIST_LIMIT;
export const PROOF_MAX_AGE_MS = 2 * 60 * 1000;                                       // = 0021 worker_fresh window at completion
export const MIRROR_READ_KEYS = Object.freeze(["accountRef", "clientSnapshotId", "httpStatus", "json", "observedAt", "request"]);
/** the 0021 persisted confirming observation (booking.offline_refund_proof_refusal: exact key set) */
export const MIRROR_EVIDENCE_OBSERVED_KEYS = Object.freeze(["amountMinor", "chargeId", "currency", "executorAccountRef", "linkedRefundCount", "listingMapId", "marker",
  "matchingChargeCount", "matchingChargeIds", "matchingRefundCount", "matchingRefundIds", "mirrorMarker", "paymentMethod", "paymentProvider", "readCount", "refundRow",
  "reservationId", "status", "title", "type"]);
export const MIRROR_REFUND_ROW_KEYS = Object.freeze(["amountMinor", "currency", "id", "listingMapId", "paymentProvider", "refundInfo", "reservationId", "status", "title", "type"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const CHARGE_TYPES = Object.freeze(["charge", "preAuth", "refund"]);
const ROW_STRING_FIELDS = Object.freeze(["type", "title", "currency", "status", "paymentProvider", "paymentMethod"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const exactKeys = (o, keys) => isObj(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const refuse = (code, extra = {}) => Object.freeze({ ok: false, code, ...extra });
const LISTS = new WeakSet();

// ---------------------------------------------------------------------------------------------
// marker / title (the mirror has its OWN marker; the original keeps mvoch1-)

export function mirrorMarker(intentId) {
  return typeof intentId === "string" && UUID_RE.test(intentId) ? `${MIRROR_MARKER_PREFIX}${intentId}` : null;
}
export function mirrorTitle(intentId) {
  const m = mirrorMarker(intentId);
  return m === null ? null : `${MIRROR_TITLE_PREFIX}${m}`;
}
/** "exact" (title === the mirror title), "suspicious" (any other title carrying the mirror marker loosely: NFKC, case, whitespace / zero-width folded), "none". */
export function classifyMirrorTitle(title, intentId) {
  const expected = mirrorTitle(intentId);
  if (expected === null) return "suspicious";
  if (typeof title !== "string") return "none";
  if (title === expected) return "exact";
  const fold = (s) => s.normalize("NFKC").toLowerCase().replace(/[\s​-‏⁠﻿]/g, "");
  if (fold(title).includes(fold(mirrorMarker(intentId)))) return "suspicious";
  return "none";
}

// ---------------------------------------------------------------------------------------------
// intent facts (the loaded intent, as the worker reads it) and the mirror row

/** null | code: a test_cleanup_pending TEST intent with BOTH legs proven and the mirror leg OPEN, recorded on a canonical offline charge. */
export function mirrorIntentRefusal(intent) {
  if (!isObj(intent) || typeof intent.id !== "string" || !UUID_RE.test(intent.id) || !Number.isSafeInteger(intent.version)) return "INTENT_INVALID";
  if (!isObj(intent.price) || !isObj(intent.payment) || !isObj(intent.settlement) || !isObj(intent.reservation)) return "INTENT_INVALID";
  if (intent.status !== S.TEST_CLEANUP_PENDING) return "NOT_TEST_CLEANUP_PENDING";
  const s = intent.settlement;
  if (s.reservationCancelled !== true || s.authorizationSettled !== true) return "LEGS_NOT_SETTLED";
  if (s.recordingMirrored !== false) return s.recordingMirrored === true ? "MIRROR_ALREADY_SETTLED" : "MIRROR_LEG_ABSENT";
  if (!isCanonicalId(String(intent.offlineChargeId ?? "")) || String(intent.offlineChargeId).startsWith("ch_")) return "OFFLINE_CHARGE_ID_INVALID";
  if (!isCanonicalId(String(intent.reservation.reservationId ?? ""))) return "RESERVATION_ID_INVALID";
  if (String(intent.offlineChargeId) === String(intent.reservation.reservationId)) return "OFFLINE_CHARGE_ID_IS_RESERVATION";
  if (!isPosInt(intent.payment.capturedMinor) || intent.payment.capturedMinor !== intent.price.finalTotalMinor) return "CAPTURED_NOT_EXACT_TOTAL";
  if (exactAmount(intent.payment.capturedMinor) === null) return "AMOUNT_NOT_EXACT";
  if (intent.price.currency !== "USD") return "CURRENCY_NOT_APPROVED";
  if (intent.payment.livemode !== false) return "INTENT_NOT_TEST_MODE";
  return null;
}
/**
 * rev2 (ROOT HOLD 5885005598 F1) null | code: the FULL identity of the persisted fresh by-id reservation evidence against the intent + recording config —
 * status cancelled (as observed, never fabricated), id, listing (intent AND config), DIRECT channel (config.channelId), stay, total = captured = final total,
 * currency (intent AND config), reference policy (bookingRef = intent.ref). ev = { kind?, externalRef, status, observed } as evidenceById returns it.
 * Any missing field is INCOMPLETE (fail closed); any differing field names the field.
 */
export function mirrorReservationEvidenceRefusal(ev, intent, config) {
  if (!isObj(ev) || !isObj(intent) || !isObj(intent.reservation) || !isObj(intent.price) || !isObj(intent.payment) || !isObj(config)) return "RESERVATION_IDENTITY_INCOMPLETE";
  if (ev.kind !== undefined && ev.kind !== "hostaway_reservation") return "RESERVATION_IDENTITY_WRONG_KIND";
  const rid = String(intent.reservation.reservationId);
  if (ev.status === "not_found") return "RESERVATION_NOT_FOUND";
  if (ev.status !== "cancelled") return "RESERVATION_NOT_CANCELLED";
  const o = ev.observed;
  if (!isObj(o)) return "RESERVATION_IDENTITY_INCOMPLETE";
  const checks = [
    ["ID", [ev.externalRef, o.reservationId], (v) => String(v) === rid],
    ["STATUS", [o.status], (v) => v === "cancelled"],
    ["LISTING", [o.listingId], (v) => v === intent.listingId && v === config.listingId],
    ["CHANNEL", [o.channelId], (v) => v === config.channelId],
    ["ARRIVAL", [o.from], (v) => v === intent.from],
    ["DEPARTURE", [o.to], (v) => v === intent.to],
    ["TOTAL", [o.totalMinor], (v) => v === intent.price.finalTotalMinor && v === intent.payment.capturedMinor],
    ["CURRENCY", [o.currency], (v) => typeof v === "string" && v.toUpperCase() === intent.price.currency && v.toUpperCase() === config.currency],
    ["REF", [o.bookingRef], (v) => v === intent.ref]
  ];
  for (const [name, values, okFn] of checks) {
    for (const v of values) {
      if (v === undefined || v === null || v === "") return name === "REF" ? "RESERVATION_IDENTITY_REF_MISMATCH" : "RESERVATION_IDENTITY_INCOMPLETE";
      if (!okFn(v)) return `RESERVATION_IDENTITY_${name}_MISMATCH`;
    }
  }
  return null;
}
/** the ONE mirror row as the worker reads it ({ id, opType, state, attempts, dispatchedAt, idempotencyKey, payload, resultRef }); pre-claim shape. */
export function mirrorOpRefusal(op, intent, { held = false } = {}) {
  if (!isObj(op) || typeof op.id !== "string" || !UUID_RE.test(op.id)) return "MIRROR_OP_INVALID";
  if (op.opType !== MIRROR_OP) return "NOT_A_MIRROR_OP";
  if (op.idempotencyKey !== `ochr:${intent.id}:1`) return "NOT_THE_SINGLE_MIRROR_KEY";
  if (!exactKeys(op.payload, ["amountMinor", "currency", "offlineChargeId", "reservationId"])) return "MIRROR_PAYLOAD_SHAPE";
  if (op.payload.reservationId !== String(intent.reservation.reservationId)) return "PAYLOAD_RESERVATION_MISMATCH";
  if (op.payload.offlineChargeId !== String(intent.offlineChargeId)) return "PAYLOAD_OFFLINE_CHARGE_MISMATCH";
  if (op.payload.amountMinor !== intent.payment.capturedMinor || op.payload.currency !== intent.price.currency) return "PAYLOAD_MONEY_MISMATCH";
  if (held) { if (op.state !== "in_flight" || op.attempts !== 1 || op.dispatchedAt === null) return "MIRROR_OP_NOT_HELD"; }
  else if (op.state !== "pending" || op.attempts !== 0 || op.dispatchedAt !== null) return "MIRROR_OP_CLAIMED_OR_SENT";
  return null;
}

// ---------------------------------------------------------------------------------------------
// the charge LIST (GET /v1/guestPayments/charges?reservationId&limit) as returned to the worker: every row typed, refund links kept

/**
 * assessMirrorList({ read, intent, config, now }) -> frozen branded { ok:true, rows, count, accountRef, clientSnapshotId, observedAt } | { ok:false, code }
 * read = { accountRef, clientSnapshotId, httpStatus, json, observedAt, request: { limit, reservationId } }. Complete page only (count = rows = reply count,
 * count <= limit). Every row: canonical id, THIS reservation / listing, typed strings, exact money (refund rows negative). A refund row's refundInfo is
 * kept TYPED: { id, chargeId, refundedChargeId } canonical, or `link: null` when absent / untyped (never dropped; the discovery fails closed on it).
 */
export function assessMirrorList({ read, intent, config, now } = {}) {
  const i = mirrorIntentRefusal(intent);
  if (i) return refuse(i);
  if (!isObj(config) || !isPosInt(config.listingId) || typeof config.accountRef !== "string" || !LABEL_RE.test(config.accountRef)) return refuse("CONFIG_INVALID");
  if (!exactKeys(read, MIRROR_READ_KEYS)) return refuse("LIST_READ_SHAPE");
  if (read.accountRef !== config.accountRef) return refuse("LIST_ACCOUNT_REF_MISMATCH");
  if (typeof read.clientSnapshotId !== "string" || !LABEL_RE.test(read.clientSnapshotId)) return refuse("LIST_CLIENT_LABEL_INVALID");
  const rid = String(intent.reservation.reservationId);
  if (!exactKeys(read.request, ["limit", "reservationId"]) || read.request.reservationId !== rid || read.request.limit !== MIRROR_LIST_LIMIT) return refuse("LIST_REQUEST_NOT_CANONICAL");
  const fr = freshnessRefusal(read.observedAt, now, PROOF_MAX_AGE_MS);
  if (fr) return refuse(`LIST_${fr}`);
  if (read.httpStatus !== 200) return refuse("LIST_HTTP_STATUS");
  const env = unwrapEnvelope(read.json);
  if (!env.ok) return refuse(`LIST_${env.code}`);
  const rows = env.result;
  if (!Array.isArray(rows)) return refuse("LIST_RESULT_NOT_ARRAY");
  const count = read.json.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > MIRROR_LIST_LIMIT) return refuse("LIST_COUNT_INVALID");
  if (rows.length !== count) return refuse("LIST_COUNT_LENGTH_MISMATCH");
  const seen = new Set(); const out = [];
  for (let k = 0; k < rows.length; k++) {
    if (!hasOwn(rows, k) || !isObj(rows[k])) return refuse("LIST_ROW_MALFORMED");
    const row = rows[k];
    const id = providerIdToCanonical(row.id);
    if (id === null) return refuse("LIST_ROW_ID_INVALID");
    if (seen.has(id)) return refuse("LIST_DUPLICATE_ID");
    seen.add(id);
    if (providerIdToCanonical(row.reservationId) !== rid) return refuse("LIST_FOREIGN_RESERVATION_ROW");
    if (row.listingMapId !== config.listingId) return refuse("LIST_FOREIGN_LISTING_ROW");
    for (const f of ROW_STRING_FIELDS) if (typeof row[f] !== "string") return refuse(`LIST_ROW_${f.toUpperCase()}_INVALID`);
    if (!CHARGE_TYPES.includes(row.type)) return refuse("LIST_ROW_TYPE_UNKNOWN");
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return refuse("LIST_ROW_AMOUNT_INVALID");
    if (row.type === "refund" ? !(row.amount <= 0 && amountToMinor(-row.amount) !== null) : amountToMinor(row.amount) === null) return refuse("LIST_ROW_AMOUNT_NOT_EXACT");
    let link = null;
    if (row.type === "refund" && isObj(row.refundInfo)) {
      const a = providerIdToCanonical(row.refundInfo.id), b = providerIdToCanonical(row.refundInfo.chargeId), c = providerIdToCanonical(row.refundInfo.refundedChargeId);
      if (a !== null && b !== null && c !== null) link = Object.freeze({ id: a, chargeId: b, refundedChargeId: c });
    }
    out.push(Object.freeze({ id, reservationId: rid, listingMapId: row.listingMapId, type: row.type, title: row.title, status: row.status, paymentProvider: row.paymentProvider,
      paymentMethod: row.paymentMethod, currency: row.currency, amountMinor: row.type === "refund" ? -amountToMinor(-row.amount) : amountToMinor(row.amount), link }));
  }
  const res = Object.freeze({ ok: true, complete: true, kind: "mirror_charge_list", reservationId: rid, accountRef: read.accountRef, clientSnapshotId: read.clientSnapshotId,
    observedAt: read.observedAt, count, rows: Object.freeze(out), intentId: intent.id, version: intent.version });
  LISTS.add(res);
  return res;
}

/** the ORIGINAL row on a list: EXACTLY ONE row with id = offlineChargeId, title exact for mvoch1-, type charge, status paid, full positive amount, currency. */
function originalRow(list, intent) {
  const och = String(intent.offlineChargeId);
  const matches = list.rows.filter((r) => r.id === och);
  if (matches.length !== 1) return { code: matches.length === 0 ? "ORIGINAL_MISSING" : "ORIGINAL_DUPLICATE" };
  const o = matches[0];
  if (classifyTitle(o.title, intent.id) !== "exact") return { code: "ORIGINAL_TITLE" };
  if (o.type !== "charge") return { code: "ORIGINAL_TYPE" };
  if (o.status !== "paid") return { code: "ORIGINAL_STATUS" };
  if (o.paymentProvider !== "offline") return { code: "ORIGINAL_PROVIDER" };
  if (!APPROVED_PAYMENT_METHODS.includes(o.paymentMethod)) return { code: "ORIGINAL_METHOD" };
  if (o.amountMinor !== intent.payment.capturedMinor) return { code: "ORIGINAL_AMOUNT" };
  if (o.currency !== intent.price.currency) return { code: "ORIGINAL_CURRENCY" };
  // the original's marker is unique on the page (no second exact / suspicious row for mvoch1-)
  const others = list.rows.filter((r) => r.id !== och && classifyTitle(r.title, intent.id) !== "none");
  if (others.length !== 0) return { code: "ORIGINAL_MARKER_NOT_UNIQUE" };
  return { original: o };
}

/**
 * mirrorDiscovery({ list, intent }) — PRE-SEND admission on a FRESH complete list (packet §4.2): the original present and unchanged; ZERO rows typed-linked to
 * it; ZERO rows carrying the mirror marker (exact or lookalike); ZERO refund rows of the recorded amount; ANY refund row without a typed link → HOLD
 * (absence cannot be proven). -> { ok:true, original } | { ok:false, code, hold }
 */
export function mirrorDiscovery({ list, intent } = {}) {
  if (mirrorIntentRefusal(intent)) return refuse(mirrorIntentRefusal(intent), { hold: false });
  if (!LISTS.has(list) || list.intentId !== intent.id) return refuse("COMPLETE_LIST_REQUIRED", { hold: false });
  const o = originalRow(list, intent);
  if (o.code) return refuse(o.code, { hold: true });
  const och = String(intent.offlineChargeId);
  const refunds = list.rows.filter((r) => r.type === "refund");
  if (refunds.some((r) => r.link === null)) return refuse("MIRROR_DISCOVERY_AMBIGUOUS", { hold: true });
  if (refunds.some((r) => r.link.refundedChargeId === och || r.link.chargeId === och || r.link.id === och)) return refuse("MIRROR_ALREADY_LINKED", { hold: true });
  if (list.rows.some((r) => classifyMirrorTitle(r.title, intent.id) !== "none")) return refuse("MIRROR_MARKER_PRESENT", { hold: true });
  if (refunds.some((r) => r.amountMinor === -intent.payment.capturedMinor)) return refuse("MIRROR_AMOUNT_PRESENT", { hold: true });
  return Object.freeze({ ok: true, original: o.original, observedAt: list.observedAt });
}

// ---------------------------------------------------------------------------------------------
// the ONE POST (field-exact body; ROOT decision isIncludeInPriceBreakdown 0) and its reply

export function buildMirrorRequest({ intent, mirrorOp } = {}) {
  const i = mirrorIntentRefusal(intent);
  if (i) return refuse(i);
  const o = mirrorOpRefusal(mirrorOp, intent, { held: true }) && mirrorOpRefusal(mirrorOp, intent);
  if (o) return refuse(o);
  const amount = exactAmount(intent.payment.capturedMinor);
  if (amount === null) return refuse("AMOUNT_NOT_EXACT");
  const request = Object.freeze({ method: "POST", path: `/v1/guestPayments/charges/${intent.reservation.reservationId}/${intent.offlineChargeId}/refund`, query: Object.freeze({}),
    body: Object.freeze({ title: mirrorTitle(intent.id), amount, isIncludeInPriceBreakdown: MIRROR_INCLUDE_IN_PRICE_BREAKDOWN }) });
  return Object.freeze({ ok: true, request });
}
/** re-validates a built request against the CURRENT facts immediately before the send (no await between this and the call start) */
export function validateMirrorRequest(request, { intent, mirrorOp } = {}) {
  const b = buildMirrorRequest({ intent, mirrorOp: mirrorOp && { ...mirrorOp, state: "pending", attempts: 0, dispatchedAt: null } });
  if (!b.ok) return b;
  if (!isObj(request) || JSON.stringify(request) !== JSON.stringify(b.request)) return refuse("REQUEST_CHANGED");
  if (mirrorOpRefusal(mirrorOp, intent, { held: true })) return refuse(mirrorOpRefusal(mirrorOp, intent, { held: true }));
  return Object.freeze({ ok: true });
}
/**
 * assessMirrorReply({ reply, request, intent }) — the reply is NOT proof; it is admitted as a CANDIDATE refund row id only when: httpStatus 200 (the
 * documented facts do not state another code; anything else → unknown), envelope success, result object, typed `result.id` === typed
 * `result.refundInfo.chargeId` (the refund ROW id), `refundInfo.refundedChargeId` === the pinned original, the refund row id ≠ the original,
 * status 'succeeded', paymentProvider 'offline'. -> { ok:true, refundId } | { ok:false, code }
 */
export function assessMirrorReply({ reply, request, intent } = {}) {
  if (mirrorIntentRefusal(intent)) return refuse(mirrorIntentRefusal(intent));
  if (!isObj(request) || request.method !== "POST") return refuse("REQUEST_INVALID");
  if (!isObj(reply) || !Number.isSafeInteger(reply.httpStatus)) return refuse("REPLY_SHAPE");
  if (reply.httpStatus !== 200) return refuse("REPLY_HTTP_STATUS");
  const env = unwrapEnvelope(reply.json);
  if (!env.ok) return refuse(`REPLY_${env.code}`);
  const r = env.result;
  if (!isObj(r)) return refuse("REPLY_RESULT_SHAPE");
  const id = providerIdToCanonical(r.id);
  if (id === null) return refuse("REPLY_ID_UNTYPED");
  if (!isObj(r.refundInfo)) return refuse("REPLY_LINK_MISSING");
  const a = providerIdToCanonical(r.refundInfo.id), b = providerIdToCanonical(r.refundInfo.chargeId), c = providerIdToCanonical(r.refundInfo.refundedChargeId);
  if (a === null || b === null || c === null) return refuse("REPLY_LINK_UNTYPED");
  const och = String(intent.offlineChargeId);
  if (c !== och) return refuse("REPLY_REFUNDED_ID_NOT_ORIGINAL");
  if (b !== id) return refuse("REPLY_ID_NOT_LINK_CHARGE_ID");
  if (id === och) return refuse("REPLY_ID_IS_ORIGINAL");
  if (r.status !== "succeeded") return refuse("REPLY_STATUS");
  if (r.paymentProvider !== "offline") return refuse("REPLY_PROVIDER");
  return Object.freeze({ ok: true, refundId: id });
}

// ---------------------------------------------------------------------------------------------
// the authoritative CONFIRMING observation (persisted as the 0021 proof shape; the database re-derives every field)

/**
 * mirrorConfirmingObservation({ list, intent, refundId }) -> { ok:true, observed } | { ok:false, code }
 * EXACTLY ONE row typed-linked to the original (refundInfo.refundedChargeId = original) and it is `refundId`; its refundInfo.chargeId = its own id;
 * type refund, status succeeded, paymentProvider offline, amount = −recorded exact, currency, title exact for the mirror marker (unique on the page);
 * the original unchanged. Lookalikes, partial / duplicate rows, missing links → refused.
 */
export function mirrorConfirmingObservation({ list, intent, refundId } = {}) {
  if (mirrorIntentRefusal(intent)) return refuse(mirrorIntentRefusal(intent));
  if (!LISTS.has(list) || list.intentId !== intent.id) return refuse("COMPLETE_LIST_REQUIRED");
  if (!isCanonicalId(refundId)) return refuse("REFUND_ID_INVALID");
  const o = originalRow(list, intent);
  if (o.code) return refuse(o.code);
  const och = String(intent.offlineChargeId);
  if (refundId === och) return refuse("REFUND_ID_IS_ORIGINAL");
  const refunds = list.rows.filter((r) => r.type === "refund");
  if (refunds.some((r) => r.link === null)) return refuse("LINK_UNTYPED");
  const linked = refunds.filter((r) => r.link.refundedChargeId === och);
  if (linked.length !== 1) return refuse(linked.length === 0 ? "LINKED_ROW_MISSING" : "LINKED_ROW_DUPLICATE");
  const m = linked[0];
  if (m.id !== refundId) return refuse("LINKED_ROW_NOT_THE_REPLY");
  if (m.link.chargeId !== m.id) return refuse("LINK_CHARGE_ID_NOT_ROW");
  const marked = list.rows.filter((r) => classifyMirrorTitle(r.title, intent.id) !== "none");
  if (marked.length !== 1 || marked[0].id !== m.id || classifyMirrorTitle(m.title, intent.id) !== "exact") return refuse("MIRROR_TITLE_NOT_UNIQUE_EXACT");
  if (m.status !== "succeeded") return refuse("MIRROR_ROW_STATUS");
  if (m.paymentProvider !== "offline") return refuse("MIRROR_ROW_PROVIDER");
  if (m.amountMinor !== -intent.payment.capturedMinor) return refuse("MIRROR_ROW_AMOUNT");
  if (m.currency !== intent.price.currency) return refuse("MIRROR_ROW_CURRENCY");
  const orig = o.original;
  const observed = Object.freeze({
    amountMinor: orig.amountMinor, chargeId: orig.id, currency: orig.currency, executorAccountRef: list.accountRef, linkedRefundCount: linked.length, listingMapId: orig.listingMapId,
    marker: offlineChargeMarker(intent.id), matchingChargeCount: 1, matchingChargeIds: Object.freeze([orig.id]), matchingRefundCount: marked.length, matchingRefundIds: Object.freeze([m.id]),
    mirrorMarker: mirrorMarker(intent.id), paymentMethod: orig.paymentMethod, paymentProvider: orig.paymentProvider, readCount: 1,
    refundRow: Object.freeze({ amountMinor: m.amountMinor, currency: m.currency, id: m.id, listingMapId: m.listingMapId, paymentProvider: m.paymentProvider,
      refundInfo: Object.freeze({ chargeId: m.link.chargeId, id: m.link.id, refundedChargeId: m.link.refundedChargeId }), reservationId: m.reservationId, status: m.status, title: m.title, type: m.type }),
    reservationId: orig.reservationId, status: orig.status, title: orig.title, type: orig.type });
  if (!exactKeys(observed, MIRROR_EVIDENCE_OBSERVED_KEYS) || !exactKeys(observed.refundRow, MIRROR_REFUND_ROW_KEYS) || observed.title !== offlineChargeTitle(intent.id)) return refuse("OBSERVATION_SHAPE");
  return Object.freeze({ ok: true, observed, refundId: m.id });
}
/** the COUNT-ONLY observation of a pre-send / reconciliation list (the accepted 0012 shape; persisted as hostaway_offline_charges evidence) */
export function mirrorCountObservation({ list, intent } = {}) {
  if (mirrorIntentRefusal(intent) || !LISTS.has(list) || list.intentId !== intent.id) return null;
  const exact = list.rows.filter((r) => classifyTitle(r.title, intent.id) === "exact").map((r) => r.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  const suspicious = list.rows.filter((r) => classifyTitle(r.title, intent.id) === "suspicious").length;
  const sameAmountPaid = list.rows.filter((r) => classifyTitle(r.title, intent.id) === "none" && r.type === "charge" && r.status === "paid" && r.amountMinor === intent.payment.capturedMinor).length;
  return Object.freeze({ clientSnapshotId: list.clientSnapshotId, complete: true, executorAccountRef: list.accountRef, lookalikeCount: suspicious, matchingChargeCount: exact.length,
    matchingChargeIds: Object.freeze(exact), readCount: 1, requestLimit: MIRROR_LIST_LIMIT, rowCount: list.count, sameAmountPaidCount: sameAmountPaid });
}
