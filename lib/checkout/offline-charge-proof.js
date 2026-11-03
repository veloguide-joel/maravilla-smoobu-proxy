// lib/checkout/offline-charge-proof.js — Stage E7.4b-0 (offline, PURE). Request / proof / read-assessment foundation for
// recording a Stripe-collected payment in Hostaway as an OFFLINE charge (bookkeeping only).
// Contract: claude/e74b-evidence-contract.md revision 2 (§5–§7, tests P1–P14). No DB, network, SDK, environment, clock reads,
// executor or E3 / planner change. Every fact and every time is an INPUT.
//
// What this module decides: the SHAPE and the BINDINGS of the facts it is given — a canonical marker / title, a frozen
// request built from immutable facts, a positive reservation-identity snapshot, a single-page charge-list assessment, a
// QUALIFIED preflight result, a create-reply candidate, a confirming-read evidence shape and an owner-resolution evidence
// shape.
//
// What it does NOT and CANNOT prove (trusted worker inputs / later reviewed steps):
//   * execution provenance: that a snapshot was really returned by an executed provider call;
//   * account authentication: `accountRef` / `clientSnapshotId` are LABELS supplied by the worker; equal labels do not
//     prove that the same actual client / credential / account served the reads and would serve the write;
//   * current DB facts, leases, claims, versions at send time, or the absence of another actor;
//   * snapshot completeness / consistency of a provider list beyond the internal checks of one page;
//   * live provider behaviour (every provider shape here is DOC-DERIVED, LIVE-UNVERIFIED), owner approval, or
//     AUTHORIZATION TO SEND. No output of this module is send authorization.
// Policy carried here: only the INITIAL recording (key och:{intent}:1) is ever eligible — no automatic resend or attempt > 1.
import { amountToMinor, minorToAmount, normalizeReservation, unwrapEnvelope, validateAdapterConfig, DIRECT_CHANNEL_ID, REF_RE, isRealDate }
  from "../hostaway-reservations.js";
import { isProtectedReservationId } from "./compensation-proof.js";

export const OFFLINE_CHARGE_PROOF_VERSION = "offline-charge-proof-v1";
export const OFFLINE_CHARGE_OP = "hostaway.record_offline_charge";
export const RECORD_PURPOSE = "INITIAL_OFFLINE_CHARGE_RECORD_ONLY";
export const PAID_STATE = "payment_captured";
export const MARKER_PREFIX = "mvoch1-";
export const TITLE_PREFIX = "maraVilla payment ";
export const APPROVED_PAYMENT_METHODS = Object.freeze(["credit_card", "other"]);   // explicit config; NO default (owner choice open)
export const APPROVED_CURRENCIES = Object.freeze(["USD"]);                         // session policy: future packages are USD
export const ACCEPTED_ACTIVE_STATUSES = Object.freeze(["new"]);                    // conservative v1
export const LIST_LIMIT = 500;                                                     // documented cap
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;                                  // inclusive
export const OWNER_RESOLUTION_SETTLE_MS = 15 * 60 * 1000;                          // = 0005 admin_resolve_operation settle period
export const QUALIFIED_RESULT = "NO_MARKER_SEEN_BY_THIS_CLIENT_LABEL_AT_THIS_TIME";
export const DISPOSITION = Object.freeze({ NOT_ELIGIBLE: "not_eligible", CASE_ONLY: "case_only", UNKNOWN_CASE: "unknown_case" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEC_ID_RE = /^[1-9]\d{0,15}$/;
const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SCHEDULED_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v > 0;
const exactKeys = (o, keys) => isObj(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const refuse = (code, disposition = DISPOSITION.NOT_ELIGIBLE) => Object.freeze({ ok: false, code, disposition });
const sameSnapshot = (a, b) => isObj(a) && isObj(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.is(a[k], b[k]));

const IDENTITIES = new WeakSet();
const LISTS = new WeakSet();
const ELIGIBILITIES = new WeakSet();
const CANDIDATES = new WeakSet();

// ---------------------------------------------------------------------------------------------
// identifiers, money, times

/** Internal canonical id: a decimal string of a positive SAFE integer (no sign, leading zero, space, exponent). */
export function isCanonicalId(s) {
  return typeof s === "string" && DEC_ID_RE.test(s) && Number.isSafeInteger(Number(s)) && String(Number(s)) === s;
}
/** Provider boundary: a JSON NUMBER that is a positive safe integer -> canonical string; anything else -> null (no recovery). */
export function providerIdToCanonical(v) {
  return isPosInt(v) ? String(v) : null;
}
/** Exact minor units -> documented float amount, or null (no throw, no float arithmetic beyond the accepted adapter helper). */
export function exactAmount(minor) {
  if (!isPosInt(minor)) return null;
  let a;
  try { a = minorToAmount(minor); } catch { return null; }
  return amountToMinor(a) === minor ? a : null;
}
/** Trusted recorded-payment timestamp (epoch ms; e.g. the DB-stamped payment_captured transition) -> "YYYY-MM-DD HH:MM:SS" UTC. */
export function formatScheduledDate(recordedPaymentAt) {
  if (!isTime(recordedPaymentAt)) return null;
  const d = new Date(recordedPaymentAt);
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  const s = `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
  return SCHEDULED_RE.test(s) ? s : null;
}
/** observedAt must be a finite positive integer, not after `now`, and at most maxAgeMs old (inclusive). */
export function freshnessRefusal(observedAt, now, maxAgeMs = SNAPSHOT_MAX_AGE_MS) {
  if (!isTime(now)) return "NOW_INVALID";
  if (!isTime(observedAt)) return "OBSERVED_AT_INVALID";
  if (observedAt > now) return "OBSERVED_IN_FUTURE";
  if (now - observedAt > maxAgeMs) return "STALE";
  return null;
}

// ---------------------------------------------------------------------------------------------
// marker / title

/** Canonical marker for the INITIAL recording of an intent (lower-case canonical UUID only); null otherwise. */
export function offlineChargeMarker(intentId) {
  return typeof intentId === "string" && UUID_RE.test(intentId) ? `${MARKER_PREFIX}${intentId}` : null;
}
export function offlineChargeTitle(intentId) {
  const m = offlineChargeMarker(intentId);
  return m === null ? null : `${TITLE_PREFIX}${m}`;
}
/** "exact" (title === expected), "suspicious" (any other title that carries the marker loosely), or "none". */
export function classifyTitle(title, intentId) {
  const expected = offlineChargeTitle(intentId);
  if (expected === null) return "suspicious";
  if (typeof title !== "string") return "none";
  if (title === expected) return "exact";
  const marker = offlineChargeMarker(intentId);
  const fold = (s) => s.normalize("NFKC").toLowerCase().replace(/[\s​-‏⁠﻿]/g, "");
  if (fold(title).includes(fold(marker)) || fold(title).includes(intentId.replace(/-/g, ""))) return "suspicious";
  return "none";
}

// ---------------------------------------------------------------------------------------------
// configuration, intent facts, recording row (all inputs; validated every time)

const CONFIG_KEYS = ["accountRef", "channelId", "currency", "listingId", "paymentMethod", "refFieldId"];
/** cfg = { accountRef, channelId: 2000, currency: "USD", listingId, paymentMethod: approved, refFieldId }. No defaults. */
export function configRefusal(cfg) {
  if (!isObj(cfg)) return "CONFIG_REQUIRED";
  if (!hasOwn(cfg, "paymentMethod") || cfg.paymentMethod === undefined || cfg.paymentMethod === null) return "PAYMENT_METHOD_UNSET";
  if (!exactKeys(cfg, CONFIG_KEYS)) return "CONFIG_SHAPE";
  if (!APPROVED_PAYMENT_METHODS.includes(cfg.paymentMethod)) return "PAYMENT_METHOD_NOT_APPROVED";
  if (!APPROVED_CURRENCIES.includes(cfg.currency)) return "CURRENCY_NOT_APPROVED";
  if (cfg.channelId !== DIRECT_CHANNEL_ID) return "CHANNEL_NOT_DIRECT";
  if (typeof cfg.accountRef !== "string" || !LABEL_RE.test(cfg.accountRef)) return "ACCOUNT_REF_INVALID";
  if (!isPosInt(cfg.listingId) || !isPosInt(cfg.refFieldId)) return "CONFIG_IDS_INVALID";
  try { validateAdapterConfig({ allowedListingIds: [cfg.listingId], refFieldId: cfg.refFieldId, channelId: cfg.channelId, currency: cfg.currency }); }
  catch (e) { return `ADAPTER_CONFIG_${e && e.code ? e.code : "INVALID"}`; }
  return null;
}
const adapterCfg = (cfg) => validateAdapterConfig({ allowedListingIds: [cfg.listingId], refFieldId: cfg.refFieldId, channelId: cfg.channelId, currency: cfg.currency });

const INTENT_KEYS = ["capturedMinor", "currency", "finalTotalMinor", "from", "intentId", "listingId", "recordedPaymentAt", "ref", "reservationId", "status", "to", "version"];
/** Intent facts as supplied by the worker (fresh DB read). recordedPaymentAt = trusted recorded-payment time, NOT the Stripe capture instant. */
export function intentRefusal(intent, cfg) {
  if (!exactKeys(intent, INTENT_KEYS)) return "INTENT_SHAPE";
  if (typeof intent.intentId !== "string" || !UUID_RE.test(intent.intentId)) return "INTENT_ID_INVALID";
  if (intent.status !== PAID_STATE) return "NOT_PAYMENT_CAPTURED";
  if (!Number.isSafeInteger(intent.version) || intent.version < 0) return "VERSION_INVALID";
  if (typeof intent.ref !== "string" || !REF_RE.test(intent.ref)) return "REF_INVALID";
  if (intent.listingId !== cfg.listingId) return "LISTING_NOT_CONFIGURED";
  if (!isRealDate(intent.from) || !isRealDate(intent.to) || !(intent.to > intent.from)) return "STAY_INVALID";
  if (!isPosInt(intent.finalTotalMinor) || intent.capturedMinor !== intent.finalTotalMinor) return "CAPTURED_NOT_EXACT_TOTAL";
  if (exactAmount(intent.capturedMinor) === null) return "AMOUNT_NOT_EXACT";
  if (intent.currency !== cfg.currency) return "CURRENCY_MISMATCH";
  if (!isCanonicalId(intent.reservationId)) return "RESERVATION_ID_INVALID";
  if (isProtectedReservationId(intent.reservationId)) return "PROTECTED_RESERVATION_ID";
  if (formatScheduledDate(intent.recordedPaymentAt) === null) return "RECORDED_PAYMENT_TIME_REQUIRED";
  return null;
}

const OP_KEYS = ["attempts", "dispatchedAt", "id", "idempotencyKey", "opType", "payload", "state"];
/** The INITIAL recording row, still pending and never claimed / dispatched; payload bound to the intent. */
export function recordingOpRefusal(op, intent) {
  if (!exactKeys(op, OP_KEYS)) return "RECORDING_OP_SHAPE";
  if (op.opType !== OFFLINE_CHARGE_OP) return "NOT_A_RECORDING_OP";
  if (typeof op.id !== "string" || !UUID_RE.test(op.id)) return "RECORDING_OP_ID_INVALID";
  if (op.idempotencyKey !== `och:${intent.intentId}:1`) return "NOT_INITIAL_ATTEMPT";
  if (op.state !== "pending" || op.attempts !== 0 || op.dispatchedAt !== null) return "RECORDING_OP_CLAIMED_OR_SENT";
  if (!exactKeys(op.payload, ["amountMinor", "reservationId"])) return "RECORDING_PAYLOAD_SHAPE";
  if (op.payload.reservationId !== intent.reservationId) return "PAYLOAD_RESERVATION_MISMATCH";
  if (op.payload.amountMinor !== intent.capturedMinor) return "PAYLOAD_AMOUNT_MISMATCH";
  return null;
}
function factsRefusal({ intent, recordingOp, config }) {
  const c = configRefusal(config);
  if (c) return c;
  const i = intentRefusal(intent, config);
  if (i) return i;
  return recordingOp === undefined ? null : recordingOpRefusal(recordingOp, intent);
}

// ---------------------------------------------------------------------------------------------
// positive identity snapshot (GET /v1/reservations/{id} as returned to the worker; DOC-DERIVED shape)

const SNAP_KEYS = ["accountRef", "clientSnapshotId", "httpStatus", "json", "observedAt"];
/**
 * assessIdentitySnapshot({ snapshot, intent, config, now }) -> frozen branded identity | { ok:false, code }
 * Every identity field is required individually and must equal the configured / intent value exactly.
 */
export function assessIdentitySnapshot({ snapshot, intent, config, now } = {}) {
  const f = factsRefusal({ intent, config });
  if (f) return refuse(f);
  if (!exactKeys(snapshot, SNAP_KEYS)) return refuse("IDENTITY_SNAPSHOT_SHAPE");
  if (snapshot.accountRef !== config.accountRef) return refuse("IDENTITY_ACCOUNT_REF_MISMATCH");
  if (typeof snapshot.clientSnapshotId !== "string" || !LABEL_RE.test(snapshot.clientSnapshotId)) return refuse("IDENTITY_CLIENT_LABEL_INVALID");
  const fr = freshnessRefusal(snapshot.observedAt, now);
  if (fr) return refuse(`IDENTITY_${fr}`);
  if (snapshot.httpStatus !== 200) return refuse("IDENTITY_HTTP_STATUS");
  const env = unwrapEnvelope(snapshot.json);
  if (!env.ok) return refuse(`IDENTITY_${env.code}`);
  const raw = env.result;
  if (!isObj(raw)) return refuse("IDENTITY_RESULT_NOT_OBJECT");
  if (raw.currency !== config.currency) return refuse("IDENTITY_CURRENCY_MISMATCH");            // exact, before any case folding
  let n;
  try { n = normalizeReservation(raw, adapterCfg(config)); } catch { return refuse("IDENTITY_NOT_NORMALIZABLE"); }
  if (!n.ok) return refuse(`IDENTITY_${n.code}`);
  const r = n.reservation;
  if (String(r.reservationId) !== intent.reservationId) return refuse("IDENTITY_RESERVATION_ID_MISMATCH");
  if (r.listingId !== config.listingId) return refuse("IDENTITY_LISTING_MISMATCH");
  if (r.channelId !== config.channelId) return refuse("IDENTITY_CHANNEL_MISMATCH");
  if (r.from !== intent.from) return refuse("IDENTITY_ARRIVAL_MISMATCH");
  if (r.to !== intent.to) return refuse("IDENTITY_DEPARTURE_MISMATCH");
  if (r.totalMinor !== intent.finalTotalMinor) return refuse("IDENTITY_TOTAL_MISMATCH");
  if (r.bookingRef !== intent.ref) return refuse("IDENTITY_REF_MISMATCH");
  if (!ACCEPTED_ACTIVE_STATUSES.includes(r.status)) return refuse("IDENTITY_STATUS_NOT_ACTIVE");
  const out = Object.freeze({ ok: true, kind: "identity", reservationId: intent.reservationId, accountRef: snapshot.accountRef,
    clientSnapshotId: snapshot.clientSnapshotId, observedAt: snapshot.observedAt });
  IDENTITIES.add(out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// single-page charge list (GET /v1/guestPayments/charges?reservationId=<id>&limit=500; DOC-DERIVED shape)

const READ_KEYS = ["accountRef", "clientSnapshotId", "httpStatus", "json", "observedAt", "request"];
const ROW_STRING_FIELDS = ["type", "title", "currency", "status", "paymentProvider", "paymentMethod"];
/**
 * assessChargeList({ read, intent, config, now }) -> frozen branded { ok:true, complete:true, rows } | { ok:false, code } (incomplete /
 * untrusted). Proves internal consistency of ONE page only — not snapshot consistency, not account correctness.
 */
export function assessChargeList({ read, intent, config, now } = {}) {
  const f = factsRefusal({ intent, config });
  if (f) return refuse(f);
  if (!exactKeys(read, READ_KEYS)) return refuse("LIST_READ_SHAPE");
  if (read.accountRef !== config.accountRef) return refuse("LIST_ACCOUNT_REF_MISMATCH");
  if (typeof read.clientSnapshotId !== "string" || !LABEL_RE.test(read.clientSnapshotId)) return refuse("LIST_CLIENT_LABEL_INVALID");
  if (!exactKeys(read.request, ["limit", "reservationId"]) || read.request.reservationId !== intent.reservationId || read.request.limit !== LIST_LIMIT) {
    return refuse("LIST_REQUEST_NOT_CANONICAL");
  }
  const fr = freshnessRefusal(read.observedAt, now);
  if (fr) return refuse(`LIST_${fr}`);
  if (read.httpStatus !== 200) return refuse("LIST_HTTP_STATUS");
  const env = unwrapEnvelope(read.json);
  if (!env.ok) return refuse(`LIST_${env.code}`);
  const rows = env.result;
  if (!Array.isArray(rows)) return refuse("LIST_RESULT_NOT_ARRAY");
  const count = read.json.count;
  if (!Number.isSafeInteger(count) || count < 0 || count > LIST_LIMIT) return refuse("LIST_COUNT_INVALID");
  if (rows.length !== count) return refuse("LIST_COUNT_LENGTH_MISMATCH");
  const seen = new Set();
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (!hasOwn(rows, i) || !isObj(rows[i])) return refuse("LIST_ROW_MALFORMED");
    const row = rows[i];
    const chargeId = providerIdToCanonical(row.id);
    if (chargeId === null) return refuse("LIST_ROW_ID_INVALID");
    if (seen.has(chargeId)) return refuse("LIST_DUPLICATE_ID");
    seen.add(chargeId);
    if (providerIdToCanonical(row.reservationId) !== intent.reservationId) return refuse("LIST_FOREIGN_RESERVATION_ROW");
    if (row.listingMapId !== config.listingId) return refuse("LIST_FOREIGN_LISTING_ROW");
    for (const k of ROW_STRING_FIELDS) if (typeof row[k] !== "string") return refuse(`LIST_ROW_${k.toUpperCase()}_INVALID`);
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) return refuse("LIST_ROW_AMOUNT_INVALID");
    out.push(Object.freeze({ chargeId, reservationId: intent.reservationId, listingMapId: row.listingMapId, type: row.type, title: row.title,
      amountMinor: amountToMinor(row.amount), currency: row.currency, status: row.status, paymentProvider: row.paymentProvider,
      paymentMethod: row.paymentMethod }));
  }
  const res = Object.freeze({ ok: true, complete: true, kind: "charge_list", reservationId: intent.reservationId, accountRef: read.accountRef,
    clientSnapshotId: read.clientSnapshotId, observedAt: read.observedAt, count, rows: Object.freeze(out) });
  LISTS.add(res);
  return res;
}

function partition(list, intent, capturedMinor) {
  const exact = []; const suspicious = []; const sameAmountPaid = [];
  for (const r of list.rows) {
    const t = classifyTitle(r.title, intent.intentId);
    if (t === "exact") exact.push(r);
    else if (t === "suspicious") suspicious.push(r);
    else if (r.type === "charge" && r.status === "paid" && r.amountMinor === capturedMinor) sameAmountPaid.push(r);
  }
  return { exact, suspicious, sameAmountPaid };
}

// ---------------------------------------------------------------------------------------------
// qualified preflight -> eligibility (PRE-CLAIM only; NOT send authorization)

const SNAPSHOT_FIELDS = (intent, op, config) => Object.freeze({ intentId: intent.intentId, intentVersion: intent.version, reservationId: intent.reservationId,
  listingId: intent.listingId, from: intent.from, to: intent.to, ref: intent.ref, capturedMinor: intent.capturedMinor, currency: intent.currency,
  recordedPaymentAt: intent.recordedPaymentAt, opId: op.id, idempotencyKey: op.idempotencyKey, payloadAmountMinor: op.payload.amountMinor,
  payloadReservationId: op.payload.reservationId, accountRef: config.accountRef, paymentMethod: config.paymentMethod, refFieldId: config.refFieldId });

/**
 * qualifyPreflight({ identity, list, intent, recordingOp, config, now }) -> frozen branded eligibility | { ok:false, code, disposition }
 * Requires a POSITIVE identity snapshot AND a complete list from the SAME client label, both fresh. An empty list alone is never enough.
 * The eligible result is QUALIFIED ("no marker seen by this client label at this time"); it never settles any write.
 */
export function qualifyPreflight({ identity, list, intent, recordingOp, config, now } = {}) {
  const f = factsRefusal({ intent, recordingOp, config });
  if (f) return refuse(f);
  if (!IDENTITIES.has(identity)) return refuse("POSITIVE_IDENTITY_REQUIRED");
  if (!LISTS.has(list)) return refuse("COMPLETE_LIST_REQUIRED");
  if (identity.reservationId !== intent.reservationId || list.reservationId !== intent.reservationId) return refuse("RESERVATION_BINDING_MISMATCH");
  if (identity.accountRef !== config.accountRef || list.accountRef !== config.accountRef) return refuse("ACCOUNT_REF_BINDING_MISMATCH");
  if (identity.clientSnapshotId !== list.clientSnapshotId) return refuse("CLIENT_LABEL_BINDING_MISMATCH");
  for (const [n, t] of [["IDENTITY", identity.observedAt], ["LIST", list.observedAt]]) {
    const fr = freshnessRefusal(t, now);
    if (fr) return refuse(`${n}_${fr}`);
  }
  const p = partition(list, intent, intent.capturedMinor);
  if (p.exact.length) return refuse("PRIOR_RECORDING_MARKER_PRESENT", DISPOSITION.CASE_ONLY);
  if (p.suspicious.length) return refuse("MARKER_LOOKALIKE_CONFLICT", DISPOSITION.CASE_ONLY);
  if (p.sameAmountPaid.length) return refuse("SAME_AMOUNT_PAID_UNMARKED_CONFLICT", DISPOSITION.CASE_ONLY);
  const e = Object.freeze({ ok: true, purpose: RECORD_PURPOSE, qualified: QUALIFIED_RESULT, sendAuthorization: false,
    clientSnapshotId: identity.clientSnapshotId, identityObservedAt: identity.observedAt, listObservedAt: list.observedAt,
    snapshot: SNAPSHOT_FIELDS(intent, recordingOp, config) });
  ELIGIBILITIES.add(e);
  return e;
}

// ---------------------------------------------------------------------------------------------
// request (frozen; POST /v1/guestPayments/charges/{reservationId}; DOC-DERIVED field set)

const REQUEST_KEYS = ["body", "method", "path", "query"];
const BODY_KEYS = ["amount", "paymentMethod", "scheduledDate", "status", "title"];
function expectedBody(intent, config) {
  return { title: offlineChargeTitle(intent.intentId), amount: exactAmount(intent.capturedMinor), paymentMethod: config.paymentMethod, status: "paid",
    scheduledDate: formatScheduledDate(intent.recordedPaymentAt) };
}
/** PRE-CLAIM: CURRENT facts must equal the eligibility snapshot, and its carried observations must still be fresh at `now`. */
export function buildOfflineChargeRequest(input = {}) {
  if (!exactKeys(input, ["config", "eligibility", "intent", "now", "recordingOp"])) return refuse("UNEXPECTED_INPUT");
  const { eligibility, intent, recordingOp, config, now } = input;
  if (!ELIGIBILITIES.has(eligibility) || eligibility.ok !== true || eligibility.purpose !== RECORD_PURPOSE) return refuse("ELIGIBILITY_REQUIRED");
  const f = factsRefusal({ intent, recordingOp, config });
  if (f) return refuse(f);
  for (const [n, t] of [["IDENTITY", eligibility.identityObservedAt], ["LIST", eligibility.listObservedAt]]) {
    const fr = freshnessRefusal(t, now);
    if (fr) return refuse(`CARRIED_${n}_${fr}`);
  }
  if (!sameSnapshot(eligibility.snapshot, SNAPSHOT_FIELDS(intent, recordingOp, config))) return refuse("ELIGIBILITY_SNAPSHOT_CHANGED");
  const request = Object.freeze({ method: "POST", path: `/v1/guestPayments/charges/${intent.reservationId}`, query: Object.freeze({}),
    body: Object.freeze(expectedBody(intent, config)) });
  const v = validateOfflineChargeRequest(request, { intent, recordingOp, config });
  return v.ok ? Object.freeze({ ok: true, request, sendAuthorization: false }) : v;
}
/** SHAPE / BINDING only: exact method, path, empty query, exactly the five documented fields (no currency / description / extras). */
export function validateOfflineChargeRequest(request, { intent, recordingOp, config } = {}) {
  const f = factsRefusal({ intent, recordingOp, config });
  if (f) return refuse(f);
  if (!exactKeys(request, REQUEST_KEYS)) return refuse("REQUEST_SHAPE");
  if (request.method !== "POST") return refuse("METHOD");
  if (request.path !== `/v1/guestPayments/charges/${intent.reservationId}`) return refuse("PATH");
  if (!exactKeys(request.query, [])) return refuse("QUERY_NOT_EMPTY");
  if (!exactKeys(request.body, BODY_KEYS)) return refuse("BODY_SHAPE");
  const want = expectedBody(intent, config);
  for (const k of BODY_KEYS) if (!Object.is(request.body[k], want[k])) return refuse(`BODY_${k.toUpperCase()}`);
  return Object.freeze({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// create reply -> candidate (NECESSARY, NOT SUFFICIENT: a reply alone is never success)

/** assessCreateReply({ reply: { httpStatus, json }, request, intent, config }) -> branded candidate | { ok:false, code, disposition:"unknown_case" } */
export function assessCreateReply({ reply, request, intent, config } = {}) {
  const u = (code) => refuse(code, DISPOSITION.UNKNOWN_CASE);
  const f = factsRefusal({ intent, config });
  if (f) return u(f);
  const body = expectedBody(intent, config);
  if (!exactKeys(request, REQUEST_KEYS) || !exactKeys(request.body, BODY_KEYS) || BODY_KEYS.some((k) => !Object.is(request.body[k], body[k]))) return u("REQUEST_NOT_BOUND");
  if (!exactKeys(reply, ["httpStatus", "json"])) return u("REPLY_SHAPE");
  if (![200, 201].includes(reply.httpStatus)) return u("REPLY_HTTP_STATUS");                     // LIVE-UNVERIFIED (E2)
  const env = unwrapEnvelope(reply.json);
  if (!env.ok) return u(`REPLY_${env.code}`);
  const r = env.result;
  if (!isObj(r)) return u("REPLY_RESULT_NOT_OBJECT");
  const chargeId = providerIdToCanonical(r.id);
  if (chargeId === null) return u("REPLY_CHARGE_ID_INVALID");
  if (providerIdToCanonical(r.reservationId) !== intent.reservationId) return u("REPLY_RESERVATION_MISMATCH");
  if (r.listingMapId !== config.listingId) return u("REPLY_LISTING_MISMATCH");
  if (r.type !== "charge") return u("REPLY_TYPE");
  if (r.paymentProvider !== "offline") return u("REPLY_PROVIDER");
  if (r.status !== "paid") return u("REPLY_STATUS");
  if (r.paymentMethod !== config.paymentMethod) return u("REPLY_METHOD");
  if (r.title !== body.title) return u("REPLY_TITLE");
  if (r.currency !== config.currency) return u("REPLY_CURRENCY");
  if (typeof r.amount !== "number" || amountToMinor(r.amount) !== intent.capturedMinor) return u("REPLY_AMOUNT");
  const c = Object.freeze({ ok: true, kind: "reply_candidate", sufficient: false, chargeId, reservationId: intent.reservationId });
  CANDIDATES.add(c);
  return c;
}

// ---------------------------------------------------------------------------------------------
// confirming read -> evidence shape (still NOT send authorization; the event transaction re-checks persisted evidence)

export const EVIDENCE_OBSERVED_KEYS = Object.freeze(["amountMinor", "chargeId", "currency", "executorAccountRef", "listingMapId", "marker",
  "matchingChargeCount", "matchingChargeIds", "paymentMethod", "paymentProvider", "readCount", "reservationId", "status", "title", "type"]);
function expectedObserved(intent, config, chargeId, readCount) {
  return { amountMinor: intent.capturedMinor, chargeId, currency: config.currency, executorAccountRef: config.accountRef, listingMapId: config.listingId,
    marker: offlineChargeMarker(intent.intentId), matchingChargeCount: 1, matchingChargeIds: [chargeId], paymentMethod: config.paymentMethod,
    paymentProvider: "offline", readCount, reservationId: intent.reservationId, status: "paid", title: offlineChargeTitle(intent.intentId), type: "charge" };
}
/**
 * assessConfirmingRead({ candidate, eligibility, list, intent, config, dispatchedAt, now })
 *   -> { ok:true, chargeId, observed (DB-validate compatible), observedAt } | { ok:false, code, disposition:"unknown_case" }
 * The list must be complete, from the same client label as the eligibility, observed strictly AFTER dispatch, and contain
 * EXACTLY one exact-title charge equal to the reply candidate; zero / multiple / look-alike / mismatch are distinct refusals.
 */
export function assessConfirmingRead({ candidate, eligibility, list, intent, config, dispatchedAt, now } = {}) {
  const u = (code) => refuse(code, DISPOSITION.UNKNOWN_CASE);
  const f = factsRefusal({ intent, config });
  if (f) return u(f);
  if (!CANDIDATES.has(candidate) || candidate.reservationId !== intent.reservationId) return u("REPLY_CANDIDATE_REQUIRED");
  if (!ELIGIBILITIES.has(eligibility) || eligibility.snapshot.intentId !== intent.intentId) return u("ELIGIBILITY_REQUIRED");
  if (!LISTS.has(list)) return u("CONFIRM_LIST_INCOMPLETE");
  if (list.reservationId !== intent.reservationId || list.accountRef !== config.accountRef) return u("CONFIRM_BINDING_MISMATCH");
  if (list.clientSnapshotId !== eligibility.clientSnapshotId) return u("CONFIRM_CLIENT_LABEL_MISMATCH");
  if (!isTime(dispatchedAt) || !isTime(now) || dispatchedAt > now) return u("DISPATCH_TIME_INVALID");
  if (!(list.observedAt > dispatchedAt)) return u("CONFIRM_NOT_AFTER_DISPATCH");
  const fr = freshnessRefusal(list.observedAt, now);
  if (fr) return u(`CONFIRM_${fr}`);
  const p = partition(list, intent, intent.capturedMinor);
  if (p.suspicious.length) return u("CONFIRM_MARKER_LOOKALIKE");
  if (p.exact.length === 0) return u("CONFIRM_ZERO_MATCH");
  if (p.exact.length > 1) return u("CONFIRM_MULTIPLE_MATCHES");
  const m = p.exact[0];
  if (m.chargeId !== candidate.chargeId) return u("CONFIRM_ID_MISMATCH");
  if (m.amountMinor !== intent.capturedMinor) return u("CONFIRM_AMOUNT_MISMATCH");
  if (m.currency !== config.currency) return u("CONFIRM_CURRENCY_MISMATCH");
  if (m.status !== "paid" || m.type !== "charge" || m.paymentProvider !== "offline") return u("CONFIRM_STATE_MISMATCH");
  if (m.paymentMethod !== config.paymentMethod) return u("CONFIRM_METHOD_MISMATCH");
  const observed = Object.freeze({ ...expectedObserved(intent, config, m.chargeId, list.count), matchingChargeIds: Object.freeze([m.chargeId]) });
  return Object.freeze({ ok: true, chargeId: m.chargeId, observed, observedAt: list.observedAt, sendAuthorization: false });
}

// ---------------------------------------------------------------------------------------------
// owner-resolution evidence shape (what E7.4b recovery would require; the existing DB function checks count + id only)

const OWNER_EVIDENCE_KEYS = ["externalRef", "kind", "observed", "observedAt", "readOpState", "readOpType", "source", "status"];
/** assessOwnerResolutionEvidence({ evidence, intent, config, dispatchedAt, resultRef }) -> { ok:true, chargeId } | { ok:false, code, disposition:"case_only" } */
export function assessOwnerResolutionEvidence({ evidence, intent, config, dispatchedAt, resultRef } = {}) {
  const c = (code) => refuse(code, DISPOSITION.CASE_ONLY);
  const f = factsRefusal({ intent, config });
  if (f) return c(f);
  if (!isCanonicalId(resultRef)) return c("RESULT_REF_INVALID");
  if (!exactKeys(evidence, OWNER_EVIDENCE_KEYS)) return c("EVIDENCE_SHAPE");
  if (evidence.source !== "hostaway_api") return c("EVIDENCE_NOT_API");
  if (evidence.kind !== "hostaway_offline_charges" || evidence.status !== "listed") return c("EVIDENCE_KIND");
  if (evidence.readOpType !== "hostaway.list_offline_charges" || evidence.readOpState !== "succeeded") return c("EVIDENCE_NOT_FROM_SUCCEEDED_LIST_READ");
  if (evidence.externalRef !== intent.reservationId) return c("EVIDENCE_RESERVATION_MISMATCH");
  if (!isTime(dispatchedAt) || !isTime(evidence.observedAt)) return c("EVIDENCE_TIME_INVALID");
  if (evidence.observedAt < dispatchedAt + OWNER_RESOLUTION_SETTLE_MS) return c("EVIDENCE_TOO_EARLY");
  const o = evidence.observed;
  if (!exactKeys(o, EVIDENCE_OBSERVED_KEYS)) return c("EVIDENCE_OBSERVED_FIELDS_INCOMPLETE");
  if (!Number.isSafeInteger(o.readCount) || o.readCount < 1 || o.readCount > LIST_LIMIT) return c("EVIDENCE_READ_COUNT_INVALID");
  const want = expectedObserved(intent, config, resultRef, o.readCount);
  if (!Array.isArray(o.matchingChargeIds) || o.matchingChargeIds.length !== 1 || o.matchingChargeIds[0] !== resultRef) return c("EVIDENCE_MATCHING_IDS");
  for (const k of EVIDENCE_OBSERVED_KEYS) {
    if (k === "matchingChargeIds") continue;
    if (!Object.is(o[k], want[k])) return c(`EVIDENCE_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}_MISMATCH`);
  }
  return Object.freeze({ ok: true, chargeId: resultRef });
}
