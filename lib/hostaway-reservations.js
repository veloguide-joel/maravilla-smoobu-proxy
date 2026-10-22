// Hostaway reservation adapter — Stage E4 (offline, pure).
//
// Translates between the E3 state machine / booking DB shapes and the Hostaway Public API reservation
// shapes. PURE: no network, no transport, no credentials, no environment, no imports, no clock. Not
// imported by any route, by db/lib or by any executor. Nothing here can send a request.
//
// Sources (read 2026-10-22 from the official reference, https://api.hostaway.com/documentation):
//   - "Reservation object" (field names and types; totalPrice is a float; customFieldValues
//     = [{ customFieldId, value }], "You should create Custom fields at the dashboard beforehand").
//   - "Create a reservation": POST /v1/reservations, body = a reservation object; "Only 2000 (direct),
//     2002 (homeaway) and 2020 (partner) are supported as channelId"; query forceOverbooking /
//     provider (neither is ever sent by this module).
//   - "Retrieve reservations": GET /v1/reservations with limit (default 100), afterId (cursor;
//     offset is deprecated), channelId, listingId, arrivalStartDate, arrivalEndDate, includeResources.
//     The docs warn that unrecognised date parameters are ignored WITHOUT an error.
//   - "Standard Response": { status: "success" | "fail", result, limit, offset, count, page, totalPages }.
//   - "Rate limits": 429 with status "fail".
// Everything the docs do not state is marked LIVE-UNVERIFIED in HOSTAWAY_RESERVATION_MAPPING and is
// handled fail-closed (any deviation => ambiguous / conflict, never "created" and never "refused").
//
// Safety rules (E4 review, 2026-10-22):
//   - E4 test-only: the configured listing allowlist must never contain the pilots 603564 / 603566.
//   - channelId is always 2000 (direct). forceOverbooking (or any query parameter) is never sent.
//   - Unknown fields are rejected at every level, and "forceOverbooking" is rejected even if nested.
//   - Exact integer minor units; real calendar dates; departure strictly after arrival.
//   - A success envelope alone never means "created": id, listing, ref, dates, amount, currency,
//     channel and status are all verified. Anything else stops as "ambiguous" or "conflict".
//   - The definite-refusal catalogue stays EMPTY: this module never classifies anything as a definite
//     refusal. An uncatalogued 4xx is only a "refusal candidate" and is reported as ambiguous.
//   - Lookup by ref uses an injected page function only, never retries, and a not-found result is
//     never authoritative. Reaching the page cap is "incomplete", never "not found".

export const ADAPTER_VERSION = "hostaway-reservations-e4-v1";
export const FORBIDDEN_PILOT_LISTING_IDS = Object.freeze([603564, 603566]);
export const DIRECT_CHANNEL_ID = 2000;
export const REF_RE = /^MV-[A-Z0-9]{6,10}$/;          // = booking.intents.ref CHECK (0001)
export const LOOKUP_PAGE_LIMIT = 100;                   // documented default list limit
export const LOOKUP_MAX_PAGES = 5;                      // protocol §3 cap
export const ACCEPTED_CREATE_STATUSES = Object.freeze(["new"]); // LIVE-UNVERIFIED (protocol X2 expectation)
const SUPPORTED_CURRENCIES = Object.freeze(["USD", "MXN"]);   // both have 2 minor-unit digits (ISO 4217)

/**
 * Field mapping, with provenance. "documented" = stated in the official reference (section named).
 * "liveUnverified" = not stated there; must be confirmed by E4 evidence before any catalogue or wiring.
 */
export const HOSTAWAY_RESERVATION_MAPPING = Object.freeze({
  request: Object.freeze({
    method: "POST /v1/reservations — documented (Create a reservation)",
    query: "always empty: forceOverbooking/provider/validatePaymentMethod never sent — documented as optional",
    channelId: "2000 (direct) — documented as a supported create channel",
    listingMapId: "plan.listingId — documented (Reservation object, required int)",
    arrivalDate: "plan.arrivalDate (YYYY-MM-DD) — documented (required date)",
    departureDate: "plan.departureDate (YYYY-MM-DD) — documented (required date)",
    numberOfGuests: "plan.guests — documented (optional int)",
    guestName: "first + ' ' + last — documented (optional string)",
    guestFirstName: "plan.guest.firstName — documented",
    guestLastName: "plan.guest.lastName — documented",
    guestEmail: "plan.guest.email — documented",
    totalPrice: "plan.totalMinor / 100 as a JSON number — documented as float; exact echo LIVE-UNVERIFIED",
    currency: "plan.currency — documented (optional string)",
    customFieldValues: "[{ customFieldId: cfg.refFieldId, value: plan.ref }] — documented shape; field id 105433 PROVISIONAL (UI row key)"
  }),
  response: Object.freeze({
    envelope: "{ status: 'success', result: <reservation> } — Standard Response documented; use for create LIVE-UNVERIFIED",
    reservationId: "result.id (int; hostawayReservationId must equal it when present) — documented",
    listingId: "result.listingMapId — documented",
    from: "result.arrivalDate — documented", to: "result.departureDate — documented",
    totalMinor: "result.totalPrice (float) -> exact minor units; number type and <= 2 decimals LIVE-UNVERIFIED",
    currency: "result.currency — documented",
    channelId: "result.channelId — documented",
    status: "result.status — documented enum; 'new' after a direct create LIVE-UNVERIFIED",
    bookingRef: "result.customFieldValues[customFieldId == cfg.refFieldId].value — documented shape; presence in create/list responses and numeric id type LIVE-UNVERIFIED"
  }),
  lookup: Object.freeze({
    request: "GET /v1/reservations?listingId&channelId=2000&arrivalStartDate&arrivalEndDate&limit=100&includeResources=1[&afterId] — documented parameters",
    pagination: "afterId cursor = last id of the previous page; stop on a short page — documented; ordering of ids LIVE-UNVERIFIED (enforced strictly increasing)",
    filters: "honoured filters LIVE-UNVERIFIED (docs: unrecognised parameters are ignored silently) — every item is checked against the filter"
  }),
  errors: Object.freeze({
    refusal: "HTTP status codes / bodies of create refusals are NOT documented — never classified as definite here",
    rateLimit: "429 { status: 'fail' } — documented"
  }),
  notBuilt: Object.freeze({
    financeField: "price-details create (financeField / isOverriddenByUser) — not built in this stage",
    cancel: "status change / cancel request — not built in this stage",
    retrieveById: "GET /v1/reservations/{id} request — not built; normalizeReservation() parses its result"
  })
});

export class AdapterError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AdapterError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// Primitive validators

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Throws if `forceOverbooking` appears as a key anywhere (any depth, any case). */
function rejectForceOverbooking(v, path = "") {
  if (Array.isArray(v)) { v.forEach((x, i) => rejectForceOverbooking(x, `${path}[${i}]`)); return; }
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k.toLowerCase() === "forceoverbooking") throw new AdapterError("FORCE_OVERBOOKING_REFUSED", `${path}${k}`);
      rejectForceOverbooking(v[k], `${path}${k}.`);
    }
  }
}

function exactKeys(obj, allowed, where) {
  if (!isPlainObject(obj)) throw new AdapterError("NOT_AN_OBJECT", where);
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new AdapterError("UNKNOWN_FIELD", `${where}.${k}`);
  for (const k of allowed) if (!Object.prototype.hasOwnProperty.call(obj, k)) throw new AdapterError("MISSING_FIELD", `${where}.${k}`);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** True only for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30, 2026-13-01, ...). */
export function isRealDate(s) {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function checkStay(arrival, departure, where) {
  if (!isRealDate(arrival)) throw new AdapterError("INVALID_DATE", `${where}.arrivalDate`);
  if (!isRealDate(departure)) throw new AdapterError("INVALID_DATE", `${where}.departureDate`);
  if (!(departure > arrival)) throw new AdapterError("DEPARTURE_NOT_AFTER_ARRIVAL", where); // ISO strings compare lexically
}

/** Integer minor units -> JSON number with at most 2 decimals, built from digits (no float arithmetic). */
export function minorToAmount(minor) {
  if (!isPosInt(minor)) throw new AdapterError("INVALID_AMOUNT_MINOR");
  const units = Math.floor(minor / 100);
  const cents = minor % 100;
  const n = Number(`${units}.${String(cents).padStart(2, "0")}`);
  if (amountToMinor(n) !== minor) throw new AdapterError("AMOUNT_NOT_EXACT"); // round-trip proof
  return n;
}

/**
 * Hostaway float -> exact integer minor units, or null. Only a finite, non-negative JSON number whose
 * shortest decimal form has at most 2 fraction digits is accepted (no exponent form, no strings).
 */
export function amountToMinor(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const s = String(value);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}

// ---------------------------------------------------------------------------------------------
// Configuration (injected; nothing here is tied to a real listing)

const CONFIG_KEYS = ["allowedListingIds", "refFieldId", "channelId", "currency"];

/**
 * cfg = { allowedListingIds: [int>0, ...], refFieldId: int>0, channelId: 2000, currency: "USD"|"MXN" }.
 * The allowlist is E4 test-only: it must never contain a pilot listing.
 */
export function validateAdapterConfig(cfg) {
  rejectForceOverbooking(cfg);
  exactKeys(cfg, CONFIG_KEYS, "cfg");
  const ids = cfg.allowedListingIds;
  if (!Array.isArray(ids) || ids.length === 0) throw new AdapterError("ALLOWLIST_EMPTY");
  if (!ids.every(isPosInt) || new Set(ids).size !== ids.length) throw new AdapterError("ALLOWLIST_INVALID");
  if (ids.some((id) => FORBIDDEN_PILOT_LISTING_IDS.includes(id))) throw new AdapterError("PILOT_LISTING_FORBIDDEN");
  if (!isPosInt(cfg.refFieldId)) throw new AdapterError("REF_FIELD_ID_INVALID");
  if (cfg.channelId !== DIRECT_CHANNEL_ID) throw new AdapterError("CHANNEL_NOT_DIRECT");
  if (!SUPPORTED_CURRENCIES.includes(cfg.currency)) throw new AdapterError("CURRENCY_UNSUPPORTED");
  return deepFreeze({ allowedListingIds: [...ids], refFieldId: cfg.refFieldId, channelId: DIRECT_CHANNEL_ID, currency: cfg.currency });
}

function checkListing(listingId, c, where) {
  if (!isPosInt(listingId)) throw new AdapterError("LISTING_ID_INVALID", where);
  if (FORBIDDEN_PILOT_LISTING_IDS.includes(listingId)) throw new AdapterError("PILOT_LISTING_FORBIDDEN", where);
  if (!c.allowedListingIds.includes(listingId)) throw new AdapterError("LISTING_NOT_ALLOWED", where);
}

// ---------------------------------------------------------------------------------------------
// 1. Create request (documented mapping; never sent from here)

const PLAN_KEYS = ["ref", "listingId", "arrivalDate", "departureDate", "guests", "guest", "totalMinor", "currency"];
const GUEST_KEYS = ["firstName", "lastName", "email"];
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u;
const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/**
 * plan = { ref, listingId, arrivalDate, departureDate, guests, guest: { firstName, lastName, email }, totalMinor, currency }
 * -> frozen { method: "POST", path: "/reservations", query: {}, body } (path is relative to /v1, as in lib/hostaway.js).
 */
export function buildCreateReservationRequest(plan, cfg) {
  const c = validateAdapterConfig(cfg);
  rejectForceOverbooking(plan);
  exactKeys(plan, PLAN_KEYS, "plan");
  exactKeys(plan.guest, GUEST_KEYS, "plan.guest");
  if (typeof plan.ref !== "string" || !REF_RE.test(plan.ref)) throw new AdapterError("REF_INVALID");
  checkListing(plan.listingId, c, "plan.listingId");
  checkStay(plan.arrivalDate, plan.departureDate, "plan");
  if (!isPosInt(plan.guests) || plan.guests > 50) throw new AdapterError("GUESTS_INVALID");
  if (plan.currency !== c.currency) throw new AdapterError("CURRENCY_MISMATCH");
  const totalPrice = minorToAmount(plan.totalMinor);
  const { firstName, lastName, email } = plan.guest;
  if (typeof firstName !== "string" || !NAME_RE.test(firstName)) throw new AdapterError("GUEST_NAME_INVALID", "firstName");
  if (typeof lastName !== "string" || !NAME_RE.test(lastName)) throw new AdapterError("GUEST_NAME_INVALID", "lastName");
  if (typeof email !== "string" || email.length > 254 || !EMAIL_RE.test(email)) throw new AdapterError("GUEST_EMAIL_INVALID");

  const body = {
    channelId: DIRECT_CHANNEL_ID,
    listingMapId: plan.listingId,
    arrivalDate: plan.arrivalDate,
    departureDate: plan.departureDate,
    numberOfGuests: plan.guests,
    guestName: `${firstName} ${lastName}`,
    guestFirstName: firstName,
    guestLastName: lastName,
    guestEmail: email,
    totalPrice,
    currency: c.currency,
    customFieldValues: [{ customFieldId: c.refFieldId, value: plan.ref }]
  };
  rejectForceOverbooking(body); // belt and braces
  return deepFreeze({ method: "POST", path: "/reservations", query: {}, body });
}

// ---------------------------------------------------------------------------------------------
// 2. Response parsing

/** Standard envelope -> { ok: true, result } | { ok: false, code }. */
export function unwrapEnvelope(json) {
  if (!isPlainObject(json) || typeof json.status !== "string") return { ok: false, code: "MALFORMED_ENVELOPE" };
  if (json.status === "fail") return { ok: false, code: "FAIL_ENVELOPE" };
  if (json.status !== "success" || !Object.prototype.hasOwnProperty.call(json, "result")) return { ok: false, code: "MALFORMED_ENVELOPE" };
  return { ok: true, result: json.result };
}

/**
 * Hostaway reservation object -> { ok: true, reservation } | { ok: false, code }. The output carries no
 * guest data: { reservationId, listingId, from, to, totalMinor, currency, channelId, status, bookingRef }.
 * It is the shape E3 RESERVATION_SUCCEEDED / reservationMatches() and recordHostawayCreateResult() consume.
 */
export function normalizeReservation(obj, cfg) {
  const c = validateAdapterConfig(cfg);
  const bad = (code) => ({ ok: false, code });
  if (!isPlainObject(obj)) return bad("MALFORMED_RESERVATION");
  if (!isPosInt(obj.id)) return bad("RESERVATION_ID_INVALID");
  if (obj.hostawayReservationId !== undefined && obj.hostawayReservationId !== obj.id) return bad("RESERVATION_ID_INCONSISTENT");
  if (!isPosInt(obj.listingMapId)) return bad("LISTING_ID_INVALID");
  if (!Number.isSafeInteger(obj.channelId)) return bad("CHANNEL_ID_INVALID");
  if (!isRealDate(obj.arrivalDate) || !isRealDate(obj.departureDate)) return bad("DATES_INVALID");
  if (!(obj.departureDate > obj.arrivalDate)) return bad("DATES_INVALID");
  const totalMinor = amountToMinor(obj.totalPrice);
  if (totalMinor === null) return bad("AMOUNT_NOT_EXACT");
  if (typeof obj.currency !== "string" || !/^[A-Za-z]{3}$/.test(obj.currency)) return bad("CURRENCY_INVALID");
  if (typeof obj.status !== "string" || obj.status === "") return bad("STATUS_INVALID");
  let bookingRef = null;
  if (obj.customFieldValues !== undefined && obj.customFieldValues !== null) {
    if (!Array.isArray(obj.customFieldValues)) return bad("CUSTOM_FIELDS_MALFORMED");
    const mine = obj.customFieldValues.filter((v) => isPlainObject(v) && v.customFieldId === c.refFieldId);
    if (mine.length > 1) return bad("REF_FIELD_DUPLICATED");
    if (mine.length === 1) {
      if (typeof mine[0].value !== "string") return bad("REF_VALUE_INVALID");
      bookingRef = mine[0].value;
    }
  }
  return {
    ok: true,
    reservation: deepFreeze({
      reservationId: obj.id, listingId: obj.listingMapId, from: obj.arrivalDate, to: obj.departureDate,
      totalMinor, currency: obj.currency.toUpperCase(), channelId: obj.channelId, status: obj.status, bookingRef
    })
  };
}

/** Field-by-field comparison with what was requested. Returns the names of mismatching fields. */
function mismatches(r, plan) {
  const m = [];
  if (r.listingId !== plan.listingId) m.push("listingId");
  if (r.from !== plan.arrivalDate) m.push("from");
  if (r.to !== plan.departureDate) m.push("to");
  if (r.totalMinor !== plan.totalMinor) m.push("totalMinor");
  if (r.currency !== plan.currency) m.push("currency");
  if (r.channelId !== DIRECT_CHANNEL_ID) m.push("channelId");
  if (r.bookingRef !== plan.ref) m.push("bookingRef");
  return m;
}

// ---------------------------------------------------------------------------------------------
// 3. Create-response classification. Outcomes: "created" | "conflict" | "ambiguous". Never "refused".

/**
 * response = { httpStatus?, json?, transportError? } as observed by a caller; plan = the plan the request
 * was built from. With an empty refusal catalogue no response is ever a definite refusal.
 */
export function classifyCreateResponse(response, plan, cfg) {
  const c = validateAdapterConfig(cfg);
  buildCreateReservationRequest(plan, c); // the plan must itself be valid and allowed
  const out = (o) => deepFreeze({ definiteRefusal: false, ...o });
  if (!isPlainObject(response)) return out({ outcome: "ambiguous", code: "NO_RESPONSE" });
  if (response.transportError) return out({ outcome: "ambiguous", code: "TRANSPORT_UNCERTAIN" });
  const s = response.httpStatus;
  if (!Number.isSafeInteger(s) || s < 100 || s > 599) return out({ outcome: "ambiguous", code: "NO_HTTP_STATUS" });
  if (s === 401 || s === 403) return out({ outcome: "ambiguous", code: "AUTH_UNCERTAIN", httpStatus: s });
  if (s === 429) return out({ outcome: "ambiguous", code: "RATE_LIMITED", httpStatus: s });
  if (s >= 500) return out({ outcome: "ambiguous", code: "UPSTREAM_5XX", httpStatus: s });
  if (s >= 400) return out({ outcome: "ambiguous", code: "UNCATALOGUED_REFUSAL_CANDIDATE", httpStatus: s, candidateCode: `HTTP_${s}` });
  if (s < 200 || s > 299) return out({ outcome: "ambiguous", code: "UNEXPECTED_HTTP_STATUS", httpStatus: s });

  const env = unwrapEnvelope(response.json);
  if (!env.ok) return out({ outcome: "ambiguous", code: env.code, httpStatus: s });
  const n = normalizeReservation(env.result, c);
  if (!n.ok) return out({ outcome: "ambiguous", code: n.code, httpStatus: s });
  const r = n.reservation;
  const mm = mismatches(r, plan);
  if (mm.length) return out({ outcome: "conflict", code: "RESERVATION_MISMATCH", httpStatus: s, mismatches: mm, reservationId: r.reservationId });
  if (!ACCEPTED_CREATE_STATUSES.includes(r.status)) {
    return out({ outcome: "conflict", code: "UNEXPECTED_RESERVATION_STATUS", httpStatus: s, reservationId: r.reservationId, status: r.status });
  }
  return out({ outcome: "created", code: "VERIFIED_CREATED", httpStatus: s, reservation: r });
}

// ---------------------------------------------------------------------------------------------
// 4. Bounded lookup by ref (injected page function; no retries; absence never authoritative)

const LOOKUP_KEYS = ["ref", "listingId", "arrivalDate", "departureDate"];

/** spec = { ref, listingId, arrivalDate, departureDate } -> frozen { method: "GET", path: "/reservations", query }. */
export function buildLookupQuery(spec, cfg, { afterId } = {}) {
  const c = validateAdapterConfig(cfg);
  rejectForceOverbooking(spec);
  exactKeys(spec, LOOKUP_KEYS, "spec");
  if (typeof spec.ref !== "string" || !REF_RE.test(spec.ref)) throw new AdapterError("REF_INVALID");
  checkListing(spec.listingId, c, "spec.listingId");
  checkStay(spec.arrivalDate, spec.departureDate, "spec");
  if (afterId !== undefined && !isPosInt(afterId)) throw new AdapterError("CURSOR_INVALID");
  const query = {
    listingId: spec.listingId, channelId: DIRECT_CHANNEL_ID,
    arrivalStartDate: spec.arrivalDate, arrivalEndDate: spec.arrivalDate,
    limit: LOOKUP_PAGE_LIMIT, includeResources: 1
  };
  if (afterId !== undefined) query.afterId = afterId;
  return deepFreeze({ method: "GET", path: "/reservations", query });
}

/**
 * fetchPage(request) -> Promise<{ httpStatus, json } | { transportError }>, injected by the caller and called
 * at most maxPages times, sequentially, never retried. Outcomes:
 *   found (exactly one verified match) | not_found (authoritative: false, always) |
 *   conflict (duplicate ref, or a match that disagrees with the spec) |
 *   incomplete (page cap reached; absence NOT asserted) | error (anything malformed or uncertain).
 */
export async function lookupByRef(spec, cfg, fetchPage, { maxPages = LOOKUP_MAX_PAGES } = {}) {
  const c = validateAdapterConfig(cfg);
  buildLookupQuery(spec, c); // validates spec
  if (typeof fetchPage !== "function") throw new AdapterError("FETCH_PAGE_REQUIRED");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > LOOKUP_MAX_PAGES) throw new AdapterError("MAX_PAGES_INVALID");
  const done = (o) => deepFreeze({ authoritative: false, ...o });
  const matches = [];
  const seen = new Set();
  let afterId;
  for (let page = 1; page <= maxPages; page++) {
    let resp;
    try {
      resp = await fetchPage(buildLookupQuery(spec, c, { afterId }));
    } catch {
      return done({ outcome: "error", code: "TRANSPORT_UNCERTAIN", pagesRead: page - 1 });
    }
    if (!isPlainObject(resp) || resp.transportError) return done({ outcome: "error", code: "TRANSPORT_UNCERTAIN", pagesRead: page - 1 });
    if (resp.httpStatus !== 200) return done({ outcome: "error", code: "HTTP_NOT_OK", httpStatus: resp.httpStatus ?? null, pagesRead: page - 1 });
    const env = unwrapEnvelope(resp.json);
    if (!env.ok) return done({ outcome: "error", code: env.code, pagesRead: page });
    if (!Array.isArray(env.result)) return done({ outcome: "error", code: "MALFORMED_PAGE", pagesRead: page });
    if (env.result.length > LOOKUP_PAGE_LIMIT) return done({ outcome: "error", code: "PAGE_OVER_LIMIT", pagesRead: page });
    let lastId = afterId ?? 0;
    for (const item of env.result) {
      const n = normalizeReservation(item, c);
      if (!n.ok) return done({ outcome: "error", code: `ITEM_${n.code}`, pagesRead: page });
      const r = n.reservation;
      if (seen.has(r.reservationId)) return done({ outcome: "error", code: "CURSOR_OVERLAP", pagesRead: page });
      if (r.reservationId <= lastId) return done({ outcome: "error", code: "CURSOR_NOT_ADVANCING", pagesRead: page });
      seen.add(r.reservationId);
      lastId = r.reservationId;
      // The docs warn that unrecognised filters are ignored silently: verify each filter on every item.
      if (r.listingId !== spec.listingId || r.channelId !== DIRECT_CHANNEL_ID || r.from !== spec.arrivalDate) {
        return done({ outcome: "error", code: "FILTER_NOT_APPLIED", pagesRead: page });
      }
      if (r.bookingRef === spec.ref) matches.push(r);
    }
    if (env.result.length < LOOKUP_PAGE_LIMIT) {
      if (matches.length > 1) return done({ outcome: "conflict", code: "DUPLICATE_REF", matchCount: matches.length, pagesRead: page });
      if (matches.length === 1) {
        const r = matches[0];
        if (r.to !== spec.departureDate) return done({ outcome: "conflict", code: "MATCH_DISAGREES", mismatches: ["to"], reservationId: r.reservationId, pagesRead: page });
        return done({ outcome: "found", code: "FOUND_BY_REF", reservation: r, pagesRead: page });
      }
      return done({ outcome: "not_found", code: "NOT_FOUND_NON_AUTHORITATIVE", pagesRead: page });
    }
    afterId = lastId;
  }
  return done({ outcome: "incomplete", code: "PAGE_CAP_REACHED", matchCount: matches.length, pagesRead: maxPages });
}

// ---------------------------------------------------------------------------------------------
// 5. Evidence: only allowlisted, non-personal keys

const EVIDENCE_KEYS = Object.freeze(["outcome", "code", "httpStatus", "candidateCode", "definiteRefusal", "authoritative",
  "mismatches", "matchCount", "pagesRead", "reservationId", "status"]);
const RESERVATION_EVIDENCE_KEYS = Object.freeze(["reservationId", "listingId", "from", "to", "totalMinor", "currency", "channelId", "status", "bookingRef"]);

/** Reduce a classification / lookup result to evidence-safe keys. Unknown keys (including any guest data) are dropped. */
export function sanitizeForEvidence(result) {
  if (!isPlainObject(result)) return deepFreeze({});
  const out = {};
  for (const k of EVIDENCE_KEYS) if (result[k] !== undefined) out[k] = Array.isArray(result[k]) ? [...result[k]] : result[k];
  if (isPlainObject(result.reservation)) {
    out.reservation = {};
    for (const k of RESERVATION_EVIDENCE_KEYS) if (result.reservation[k] !== undefined) out.reservation[k] = result.reservation[k];
  }
  return deepFreeze(out);
}
