// POST /api/hostaway/quote   body: { id, from, to, guests }
// Stage D read-only pricing diagnostic (owner-authorized 2026-10-17).
//
// Upstream: POST /v1/listings/{id}/calendar/priceDetails  (docs: "Calculate
// reservation price", API version 2). Body sent is EXACTLY
//   { startingDate, endingDate, numberOfGuests, version: 2 }
// — no markup, no coupon, no components. It is a calculation; it does not
// create reservations. Verified separately by calendar reads before/after.
//
// Currency: the price-details object documents no currency field, so the
// currency is read from the listing's own configuration (GET /v1/listings/{id}
// -> currencyCode) and reported with its source. Any currency-looking field
// that the quote payload happens to contain is reported too, never assumed.
//
// IMPORTANT: a successful quote does NOT establish bookability. Whether
// Hostaway prices unavailable/invalid stays is exactly what this diagnostic
// is for; callers must combine with the calendar (Stage C).

import { getHostawayEnvStatus, hostawayGet, hostawayPost } from "../../lib/hostaway.js";
import { requireDiagKey } from "../../lib/diag-auth.js";

const PILOT_LISTING_IDS = new Set([603564, 603566]);
const MAX_NIGHTS = 90;
const MAX_GUESTS = 10;
const MAX_BODY_BYTES = 2048;

const COMPONENT_FIELD_WHITELIST = [
  "type", "name", "title", "alias", "quantity", "value", "total",
  "isIncludedInTotalPrice", "isMandatory", "isQuantitySelectable", "isOverriddenByUser", "isDeleted",
  "listingFeeSettingId"
];

function parseListingId(v) {
  if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e12) return v;
  if (typeof v === "string" && /^\d{1,12}$/.test(v)) return Number(v);
  return null;
}
function parseISODate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}
function nightsBetween(fromIso, toIso) {
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(toIso) - p(fromIso)) / 86400000);
}
function parseGuests(v) {
  const n = typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_GUESTS) return null;
  return n;
}
function describeType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
}
function keyTypes(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = describeType(obj[k]);
  return out;
}
function round2(n) { return Math.round(n * 100) / 100; }

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    if (req.body.length > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" });
    return JSON.parse(req.body);
  }
  // Fallback for runtimes that do not pre-parse.
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > MAX_BODY_BYTES) reject(Object.assign(new Error("body too large"), { code: "BODY_TOO_LARGE" })); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }
  if (!requireDiagKey(req, res)) return;

  // --- Local validation (nothing reaches Hostaway until all pass) ---
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.code === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "INVALID_JSON" });
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({ ok: false, error: "INVALID_JSON" });
    return;
  }

  const id = parseListingId(body.id);
  if (id === null) { res.status(400).json({ ok: false, error: "INVALID_LISTING_ID" }); return; }
  if (!PILOT_LISTING_IDS.has(id)) { res.status(404).json({ ok: false, error: "LISTING_NOT_IN_PILOT" }); return; }

  const from = parseISODate(body.from);
  const to = parseISODate(body.to);
  if (!from || !to) { res.status(400).json({ ok: false, error: "INVALID_DATE", expected: "from/to as YYYY-MM-DD" }); return; }
  const nights = nightsBetween(from, to);
  if (nights < 1) { res.status(400).json({ ok: false, error: "STAY_TOO_SHORT", detail: "to must be after from (at least 1 night)" }); return; }
  if (nights > MAX_NIGHTS) { res.status(400).json({ ok: false, error: "STAY_TOO_LONG", maxNights: MAX_NIGHTS }); return; }

  const guests = parseGuests(body.guests);
  if (guests === null) { res.status(400).json({ ok: false, error: "INVALID_GUESTS", expected: `integer 1..${MAX_GUESTS}` }); return; }

  const env = getHostawayEnvStatus();
  if (!env.ok) { res.status(500).json({ ok: false, error: "HOSTAWAY_ENV_MISSING", missing: env.missing }); return; }

  try {
    // 1) Currency from the listing's own configuration (not assumed from the quote).
    const listingResp = await hostawayGet(`/listings/${id}`);
    const listingObj = listingResp.json && typeof listingResp.json.result === "object" ? listingResp.json.result : null;
    const currency = {
      code: listingObj && typeof listingObj.currencyCode === "string" ? listingObj.currencyCode : null,
      source: listingObj ? "listing.currencyCode" : "unavailable",
      listingLookupStatus: listingResp.status
    };
    const listingLimits = listingObj
      ? { personCapacity: listingObj.personCapacity ?? null, guestsIncluded: listingObj.guestsIncluded ?? null, priceForExtraPerson: listingObj.priceForExtraPerson ?? null, minNights: listingObj.minNights ?? null, maxNights: listingObj.maxNights ?? null, basePrice: listingObj.price ?? null }
      : null;

    // 2) The quote.
    const upstreamBody = { startingDate: from, endingDate: to, numberOfGuests: guests, version: 2 };
    const { status, json, tokenSource, retried } = await hostawayPost(`/listings/${id}/calendar/priceDetails`, upstreamBody);

    // Upstream said "fail" (or non-2xx): report the status + bounded message. This is data
    // we WANT to see — it tells us how Hostaway treats invalid stays.
    const upstreamStatusField = json && typeof json.status === "string" ? json.status : null;
    const hasFailEnvelope = upstreamStatusField && upstreamStatusField !== "success";
    if (!hasFailEnvelope && (status < 200 || status >= 300 || !json)) {
      // Transport/server failure, not a pricing decision.
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_FAILED", upstream: { status }, _meta: { upstreamStatus: status, tokenSource, retriedAfterAuthError: retried } });
      return;
    }
    if (hasFailEnvelope) {
      const msg = json && typeof json.result === "string" ? json.result.slice(0, 200)
        : json && typeof json.message === "string" ? json.message.slice(0, 200) : null;
      res.status(422).json({
        ok: false,
        error: "HOSTAWAY_QUOTE_REJECTED",
        upstream: { status, statusField: upstreamStatusField, message: msg },
        stay: { listingId: id, from, to, nights, guests },
        currency,
        _meta: { upstreamStatus: status, tokenSource, retriedAfterAuthError: retried }
      });
      return;
    }

    const result = json.result && typeof json.result === "object" ? json.result : null;
    if (!result || !Array.isArray(result.components)) {
      res.status(502).json({ ok: false, error: "HOSTAWAY_UPSTREAM_UNEXPECTED_SHAPE", upstream: { status }, _schema: { wrapperKeys: keyTypes(json), resultKeys: keyTypes(result) } });
      return;
    }

    // 3) Sanitize components (whitelist) and check the arithmetic without adjusting it.
    const components = result.components.map((c) => {
      const out = {};
      for (const f of COMPONENT_FIELD_WHITELIST) if (c && Object.prototype.hasOwnProperty.call(c, f)) out[f] = c[f];
      return out;
    });
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
    const sumIncluded = round2(components.filter((c) => c.isIncludedInTotalPrice === 1 || c.isIncludedInTotalPrice === true).reduce((a, c) => a + num(c.total), 0));
    const sumAll = round2(components.reduce((a, c) => a + num(c.total), 0));
    const totalPrice = typeof result.totalPrice === "number" ? result.totalPrice : Number(result.totalPrice);
    const byType = {};
    for (const c of components) { const t = c.type ?? "unknown"; byType[t] = round2((byType[t] || 0) + num(c.total)); }

    // Any currency-looking field on the quote payload itself? Report, don't assume.
    const quoteCurrencyFields = Object.keys(result).filter((k) => /currenc/i.test(k)).map((k) => ({ key: k, type: describeType(result[k]) }));

    res.status(200).json({
      ok: true,
      stay: { listingId: id, from, to, nights, guests },
      totalPrice,
      originalTotalPrice: typeof result.originalTotalPrice === "number" ? result.originalTotalPrice : null,
      currency,
      components,
      byType,
      sumCheck: {
        sumIncludedTotals: sumIncluded,
        sumAllTotals: sumAll,
        matchesTotalPrice: Math.abs(sumIncluded - totalPrice) < 0.005,
        difference: round2(sumIncluded - totalPrice)
      },
      listingLimits,
      bookability: "NOT ESTABLISHED BY THIS RESPONSE — combine with calendar availability",
      _schema: {
        resultKeys: keyTypes(result),
        componentKeys: keyTypes(result.components[0] || null),
        extraComponentsCount: Array.isArray(result.extraComponents) ? result.extraComponents.length : null,
        selectedComponentsCount: Array.isArray(result.selectedComponents) ? result.selectedComponents.length : null,
        quoteCurrencyFields
      },
      _meta: { upstreamStatus: status, tokenSource, retriedAfterAuthError: retried, requestSent: upstreamBody }
    });
  } catch (err) {
    const code = err?.code || "HOSTAWAY_REQUEST_FAILED";
    const httpStatus = code === "HOSTAWAY_ENV_MISSING" ? 500 : 502;
    const payload = { ok: false, error: code };
    if (err?.upstreamStatus) payload.upstream = { status: err.upstreamStatus };
    if (err?.missing) payload.missing = err.missing;
    console.error("[hostaway/quote] failed", { code, upstreamStatus: err?.upstreamStatus ?? null });
    res.status(httpStatus).json(payload);
  }
}
