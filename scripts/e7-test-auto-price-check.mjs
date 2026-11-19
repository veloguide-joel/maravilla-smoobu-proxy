// scripts/e7-test-auto-price-check.mjs — C124 Hostaway PRICE CALCULATION check for the FIXED TEST listing 606998 (no state anywhere).
//
// Sends exactly ONE request: POST https://api.hostaway.com/v1/listings/606998/calendar/priceDetails with the body
//   {"startingDate":"<check-in>","endingDate":"<check-out>","numberOfGuests":<n>,"version":2}
// — the same calculation the reviewed server pricer (lib/checkout/server-pricer.js) and the Stage D diagnostic (api/hostaway/quote.js)
// send, documented by Hostaway as "Calculate reservation price" (a calculation; creating a reservation is a different endpoint). The
// optional markup / reservationCouponId / components fields are NEVER sent. Stage D (2026-10-17) verified live that this endpoint
// creates nothing (calendar before / after unchanged).
//   * the listing is a fixed literal; only check-in / check-out (half-open, 1–31 nights, not past, ≤ 730 days ahead) and a guest count
//     (integer 1–10) are inputs
//   * headers: Accept / Authorization Bearer (existing E7_HOSTAWAY_TOKEN) / Cache-control no-cache / Content-Type application/json
//   * one non-keep-alive socket, 8 s timeout, NO retry, NO redirect follow (3xx = FAIL), NO token mint / refresh, reply ≤ 1 MiB in memory
//   * no other request: no checkout API, no database, no Stripe, no reservation, calendar, listing-fee or any mutation endpoint
// Output: an ALLOWLIST only — totalPrice, and per component type / name / title / value / total / isIncludedInTotalPrice / isMandatory
// (safe strings, finite numbers), plus a sum check. Never the token, headers, raw body, ids, coupons, extraComponents / selectedComponents.
// The reply carries no currency field (Stage D); the currency line says so instead of guessing.
// OUTSIDE every runner frame and the TEST arm release; it enables nothing and changes no flag, setting, schedule or secret.

import https from "node:https";
import { fileURLToPath } from "node:url";

export const NAME = "e7-test-auto-price-check";

export const CONSTANTS = Object.freeze({
  listingId: 606998,
  maxNights: 31,
  maxLeadDays: 730,
  maxGuests: 10,
  maxComponents: 50,
  hostaway: Object.freeze({ host: "api.hostaway.com", port: 443, timeoutMs: 8000, maxBodyBytes: 1024 * 1024 }),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

export function parseIsoDate(v) {
  if (typeof v !== "string" || !DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}
const toMs = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d); };

/** strict inputs → { ok:true, checkIn, checkOut, nights, guests } | { ok:false, code }; `today` (UTC YYYY-MM-DD) injected */
export function validateInputs(checkIn, checkOut, guestsText, today) {
  const a = parseIsoDate(checkIn); const b = parseIsoDate(checkOut); const t = parseIsoDate(today);
  if (!a) return { ok: false, code: "CHECK_IN_INVALID" };
  if (!b) return { ok: false, code: "CHECK_OUT_INVALID" };
  if (!t) return { ok: false, code: "TODAY_INVALID" };
  const n = Math.round((toMs(b) - toMs(a)) / DAY_MS);
  if (n < 1) return { ok: false, code: "RANGE_EMPTY_OR_REVERSED" };
  if (n > CONSTANTS.maxNights) return { ok: false, code: "RANGE_TOO_LONG" };
  if (toMs(a) < toMs(t)) return { ok: false, code: "CHECK_IN_IN_PAST" };
  if (toMs(a) > toMs(t) + CONSTANTS.maxLeadDays * DAY_MS) return { ok: false, code: "CHECK_IN_TOO_FAR" };
  if (typeof guestsText !== "string" || !/^[1-9][0-9]?$/.test(guestsText) || Number(guestsText) > CONSTANTS.maxGuests) return { ok: false, code: "GUESTS_INVALID" };
  return { ok: true, checkIn: a, checkOut: b, nights: n, guests: Number(guestsText) };
}

/** the exact body: four keys in this order, nothing else ever */
export function priceBody(v) {
  return JSON.stringify({ startingDate: v.checkIn, endingDate: v.checkOut, numberOfGuests: v.guests, version: 2 });
}

export function priceRequestOptions(v, token) {
  const body = priceBody(v);
  return {
    body,
    options: {
      method: "POST", host: CONSTANTS.hostaway.host, port: CONSTANTS.hostaway.port,
      path: `/v1/listings/${CONSTANTS.listingId}/calendar/priceDetails`,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Cache-control": "no-cache",
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: CONSTANTS.hostaway.timeoutMs,
    },
  };
}

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const SAFE_TEXT = /^[A-Za-z0-9 _.,:()/&%+'-]{1,60}$/;
const safeText = (v) => (typeof v === "string" && SAFE_TEXT.test(v) ? v : null);
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bit = (v) => (v === 0 || v === 1 || v === true || v === false ? (v === 1 || v === true ? 1 : 0) : null);
const cents = (x) => Math.round(x * 100);

/**
 * reply → { ok:true, totalPrice, components:[allowlisted], sumIncluded, sumMatches } | { ok:false, code }
 * Fails closed on anything not exactly the documented price-details object; nothing outside the allowlist is ever copied.
 */
export function sanitizePriceDetails(json) {
  if (!isObj(json)) return { ok: false, code: "SHAPE_NOT_OBJECT" };
  if (json.status !== "success") return { ok: false, code: json.status === "fail" ? "HOSTAWAY_FAIL" : "SHAPE_STATUS_NOT_SUCCESS" };
  const r = json.result;
  if (!isObj(r)) return { ok: false, code: "SHAPE_NO_RESULT_OBJECT" };
  const total = finite(r.totalPrice);
  if (total === null || total < 0) return { ok: false, code: "TOTAL_INVALID" };
  if (!Array.isArray(r.components) || r.components.length === 0) return { ok: false, code: "COMPONENTS_MISSING" };
  if (r.components.length > CONSTANTS.maxComponents) return { ok: false, code: "COMPONENTS_TOO_MANY" };
  const components = [];
  for (const c of r.components) {
    if (!isObj(c)) return { ok: false, code: "COMPONENT_MALFORMED" };
    const out = { type: safeText(c.type), name: safeText(c.name), title: safeText(c.title), value: finite(c.value), total: finite(c.total),
      isIncludedInTotalPrice: bit(c.isIncludedInTotalPrice), isMandatory: bit(c.isMandatory) };
    if (out.type === null || out.name === null || out.total === null || out.isIncludedInTotalPrice === null) return { ok: false, code: "COMPONENT_MALFORMED" };
    components.push(out);
  }
  const sumIncluded = components.filter((c) => c.isIncludedInTotalPrice === 1).reduce((s, c) => s + cents(c.total), 0) / 100;
  return { ok: true, totalPrice: total, components, sumIncluded, sumMatches: cents(sumIncluded) === cents(total) };
}

/** ONE POST, no retry, no redirect. Resolves { ok, code, http, price? } — never rejects, never carries token / body / headers. */
export function readPriceDetails({ token, inputs, request = null }) {
  return new Promise((resolve) => {
    let done = false; const finish = (r) => { if (!done) { done = true; resolve(r); } };
    if (typeof token !== "string" || token.length === 0) return finish({ ok: false, code: "TOKEN_MISSING", http: null });
    if (!/^[\x21-\x7e]+$/.test(token)) return finish({ ok: false, code: "TOKEN_SHAPE", http: null });
    const { options, body } = priceRequestOptions(inputs, token);
    const send = request ?? ((o, cb) => https.request({ ...o, agent: new https.Agent({ keepAlive: false, maxSockets: 1 }) }, cb));
    let req;
    try {
      req = send(options, (res) => {
        const s = res.statusCode;
        if (!Number.isInteger(s)) { res.destroy(); return finish({ ok: false, code: "HTTP_NO_STATUS", http: null }); }
        if (s >= 300 && s <= 399) { res.destroy(); return finish({ ok: false, code: "REDIRECT_REFUSED", http: s }); }
        if (s < 200 || s > 299) { res.destroy(); return finish({ ok: false, code: `HTTP_${s >= 500 ? "5XX" : s >= 400 ? "4XX" : "OTHER"}`, http: s }); }
        const chunks = []; let n = 0;
        res.on("data", (c) => { n += c.length; if (n > CONSTANTS.hostaway.maxBodyBytes) { res.destroy(); finish({ ok: false, code: "BODY_TOO_LARGE", http: s }); } else chunks.push(c); });
        res.on("error", () => finish({ ok: false, code: "READ_ERROR", http: s }));
        res.on("end", () => {
          let j; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return finish({ ok: false, code: "JSON_INVALID", http: s }); }
          const p = sanitizePriceDetails(j);
          finish(p.ok ? { ok: true, code: "PRICE_CALCULATED", http: s, price: p } : { ok: false, code: p.code, http: s });
        });
      });
    } catch { return finish({ ok: false, code: "REQUEST_ERROR", http: null }); }
    req.on("timeout", () => { req.destroy(); finish({ ok: false, code: "TIMEOUT", http: null }); });
    req.on("error", (e) => finish({ ok: false, code: e && typeof e.code === "string" && /^E[A-Z_]{2,24}$/.test(e.code) ? `REQUEST_${e.code}` : "REQUEST_ERROR", http: null }));
    req.end(body); // the ONE fixed body; nothing else is ever written
  });
}

const money = (x) => (x === null ? "null" : (cents(x) / 100).toFixed(2));

/** the printed report: allowlisted fields only */
export function report(inputs, r) {
  const head = `listing=${CONSTANTS.listingId} stay=[${inputs.checkIn},${inputs.checkOut}) nights=${inputs.nights} guests=${inputs.guests} version=2`;
  if (!r.ok) return [head, `RESULT FAIL code=${r.code} http=${r.http ?? "none"}`];
  const lines = [head];
  for (const c of r.price.components) {
    lines.push(`component type=${c.type} name=${c.name} title=${c.title ?? "null"} value=${money(c.value)} total=${money(c.total)}`
      + ` included=${c.isIncludedInTotalPrice} mandatory=${c.isMandatory ?? "null"}`);
  }
  lines.push(`totalPrice=${money(r.price.totalPrice)} sumIncluded=${money(r.price.sumIncluded)} sumMatches=${r.price.sumMatches}`);
  lines.push("currency=NOT_IN_RESPONSE (the price-details reply has no currency field; the listing's own currency is not read by this check)");
  lines.push(`RESULT ${r.price.sumMatches ? "PASS" : "FAIL"} code=${r.price.sumMatches ? "PRICE_CALCULATED" : "SUM_MISMATCH"} http=${r.http}`);
  return lines;
}

async function main(env) {
  const say = (s) => process.stdout.write(`${NAME} ${s}\n`);
  const inputs = validateInputs(env.E7_CHECK_IN, env.E7_CHECK_OUT, env.E7_GUESTS, new Date().toISOString().slice(0, 10));
  let token = env.E7_HOSTAWAY_TOKEN ?? ""; delete env.E7_HOSTAWAY_TOKEN;
  if (!inputs.ok) { token = null; say(`RESULT FAIL code=${inputs.code} http=none`); return 3; }
  const r = await readPriceDetails({ token, inputs }); token = null;
  const lines = report(inputs, r);
  for (const l of lines) say(l);
  return r.ok && r.price.sumMatches ? 0 : 3;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.env).then((c) => process.exit(c), () => { process.stdout.write(`${NAME} RESULT FAIL code=SCRIPT_ERROR http=none\n`); process.exit(3); });
}
