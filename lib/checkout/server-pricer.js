// lib/checkout/server-pricer.js — Stage E6 (offline). Server-side final price for one stay, for intent creation.
//
// The browser supplies only listingId/from/to/guests (validated by validateCheckoutRequest before this runs).
// Every figure comes from FRESH Hostaway reads through an INJECTED read-only client { get(path, opts), post(path, body, opts) }:
//   GET  /listings/{id}                          capacity / stay limits / LISTING currency
//   GET  /listings/{id}/calendar                 from..to inclusive (sanitized days)
//   POST /listings/{id}/calendar/priceDetails    a calculation (creates nothing in Hostaway)
// then lib/bookability.js evaluateStay() and lib/checkout/final-price.js computeFinalPrice() (checkout mode).
//
// Currency: the listing's own currency must equal the currency configured for that TEST listing (MXN for the approved
// pilot snapshots, USD for USD listings); no browser currency, no conversion, no FX. Listing/source currency and the
// Stripe charge currency are the same value here; Stripe settlement configuration is a separate, unknown matter.
import { evaluateStay } from "../bookability.js";
import { sanitizeDay } from "../hostaway-calendar.js";
import { computeFinalPrice } from "./final-price.js";

const TIMEOUT_MS = 8000;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * priceStay({ request, listingConfig:{ currency }, client, policy, today, now }) -> { ok:true, price } | { ok:false, error }
 * error codes: LISTING_UNAVAILABLE | CURRENCY_NOT_CONFIGURED | AVAILABILITY_UNAVAILABLE | NOT_BOOKABLE | PRICE_UNAVAILABLE
 *              | PRICE_REFUSED (final-price refused the payload: taxes, ambiguous components, bounds, ...)
 */
export async function priceStay({ request, listingConfig, client, policy, today, now }) {
  const { listingId: id, from, to, guests } = request;
  const safe = async (fn) => { try { return await fn(); } catch { return null; } };

  const l = await safe(() => client.get(`/listings/${id}`, { timeoutMs: TIMEOUT_MS }));
  const raw = l && l.status >= 200 && l.status < 300 && isObj(l.json) && isObj(l.json.result) ? l.json.result : null;
  if (!raw || Number(raw.id) !== id) return { ok: false, error: "LISTING_UNAVAILABLE" };
  const currency = typeof raw.currencyCode === "string" && /^[A-Z]{3}$/.test(raw.currencyCode) ? raw.currencyCode : null;
  if (!currency || currency !== listingConfig.currency) return { ok: false, error: "CURRENCY_NOT_CONFIGURED" };
  const listing = { id, personCapacity: raw.personCapacity, minNights: raw.minNights, maxNights: raw.maxNights };

  const c = await safe(() => client.get(`/listings/${id}/calendar`, { query: { startDate: from, endDate: to }, timeoutMs: TIMEOUT_MS }));
  const fetchedAt = now;
  const rawDays = c && c.status >= 200 && c.status < 300 && c.json ? (Array.isArray(c.json) ? c.json : Array.isArray(c.json.result) ? c.json.result : null) : null;
  if (!rawDays || rawDays.length === 0) return { ok: false, error: "AVAILABILITY_UNAVAILABLE" };
  const days = rawDays.map(sanitizeDay).filter(Boolean);

  const bookability = evaluateStay({ listingId: id, allowedListingIds: [id], listing, days, from, to, guests, today, now, calendarFetchedAt: fetchedAt });
  if (!bookability.bookable) return { ok: false, error: "NOT_BOOKABLE" };

  const p = await safe(() => client.post(`/listings/${id}/calendar/priceDetails`, { startingDate: from, endingDate: to, numberOfGuests: guests, version: 2 }, { timeoutMs: TIMEOUT_MS }));
  if (!p || p.status < 200 || p.status >= 300 || !isObj(p.json)) return { ok: false, error: "PRICE_UNAVAILABLE" };
  const fp = computeFinalPrice({ request: { listingId: id, from, to, guests }, bookability, priceDetails: p.json, currency, policy, allowedCurrencies: [listingConfig.currency] });
  if (!fp.ok) return { ok: false, error: fp.error === "NOT_BOOKABLE" ? "NOT_BOOKABLE" : "PRICE_REFUSED" };
  return { ok: true, price: fp.price };
}
