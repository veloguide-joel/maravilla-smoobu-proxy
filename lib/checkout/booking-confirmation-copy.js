// lib/checkout/booking-confirmation-copy.js — Stage E7 guest notification: BILINGUAL BOOKING-CONFIRMATION COPY foundation (C36). PURE:
// no I/O, no clock, no environment, no network, no database, no transport, no credentials, no sender / recipient / contact data.
//
// Contract "bcc-v1" — versioned INDEPENDENTLY of the Stage 2 request/hash/render contract "gn-v1" (lib/checkout/guest-notification.js,
// 0016 notification_renders.template_version CHECK = 'gn-v1'), which is preserved byte-for-byte and still owns the ONE email-shaped request,
// its content hash and the injected-executor send path. THIS MODULE IS NOT YET INTEGRATED with that builder, the worker, or the SQL fence:
// binding it to a request / render contract requires a separately reviewed builder change and a migration (a new template_version).
//
// Product choice (ROOT, delegated authority, 2026-11-14): plain text, English and Mexican Spanish, EXPLICIT locale "en" | "es" (never
// guessed from a name, e-mail or country), brand "maraVilla", ONLY the template "booking_confirmed". No refund / cancellation / failure
// assurances, no links, no HTML, no access instructions, no policy text. The booking facts are TRUST input from reviewed state: rendering
// this copy is NOT proof that a payment was received, that a reservation is confirmed, or that anything was delivered.
import { formatUsd } from "./guest-notification.js";

export const COPY_CONTRACT_VERSION = "bcc-v1";
export const BRAND = "maraVilla";
export const LOCALES = Object.freeze(["en", "es"]);
export const TEMPLATES = Object.freeze(["booking_confirmed"]);
export const FACT_KEYS = Object.freeze(["checkIn", "checkOut", "currency", "guests", "nights", "ref", "totalMinor"]);
export const COPY_KEYS = Object.freeze(["contractVersion", "locale", "subject", "template", "text"]);
export const LIMITS = Object.freeze({ maxNights: 365, maxGuests: 50, maxTotalMinor: 1_000_000_000 });   // USD 10,000,000.00 ceiling on a confirmation

const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

const refuse = (code) => Object.freeze({ ok: false, code });
export const INPUT_KEYS = Object.freeze(["facts", "locale", "template"]);

/**
 * Descriptor-based EXACT-SHAPE extraction (C37 / ROOT F1): a plain or null-prototype object whose OWN keys (Reflect.ownKeys — string AND
 * symbol, enumerable or hidden) are exactly `keys`, each an own ENUMERABLE DATA property. Accessors are rejected WITHOUT being invoked;
 * hidden / symbol extras are rejected; nothing is coerced. Any trap thrown by a hostile prototype, descriptor or Proxy inside this pure
 * boundary maps to `code` (never rethrown, never echoed). Returns a one-time plain snapshot of the values, or { code }.
 */
function extractExact(obj, keys, code) {
  try {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { code };
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return { code };
    if (Reflect.ownKeys(obj).length !== keys.length) return { code };
    const out = {};
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (d === undefined || d.enumerable !== true || !Object.hasOwn(d, "value")) return { code };
      out[k] = d.value;
    }
    return { values: out };
  } catch {
    return { code };
  }
}

/** "YYYY-MM-DD" → UTC epoch ms of that REAL calendar day (leap days included), or null (shape, range, Feb 30, Apr 31, …) */
export function calendarDayMs(s) {
  if (typeof s !== "string") return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2199 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

/** strict facts validation → frozen copy of the seven facts, or a code */
function validateFacts(facts) {
  const x = extractExact(facts, FACT_KEYS, "FACTS_SHAPE");
  if (x.code) return x;
  const { ref, checkIn, checkOut, nights, guests, totalMinor, currency } = x.values;
  if (typeof ref !== "string" || !REF_RE.test(ref)) return { code: "REF_INVALID" };
  const inMs = calendarDayMs(checkIn), outMs = calendarDayMs(checkOut);
  if (inMs === null || outMs === null) return { code: "DATE_INVALID" };
  if (!(outMs > inMs)) return { code: "DATE_ORDER_INVALID" };
  const diff = (outMs - inMs) / DAY_MS;
  if (!Number.isSafeInteger(nights) || nights < 1 || nights > LIMITS.maxNights || nights !== diff) return { code: "NIGHTS_MISMATCH" };
  if (!Number.isSafeInteger(guests) || guests < 1 || guests > LIMITS.maxGuests) return { code: "GUESTS_INVALID" };
  if (currency !== "USD") return { code: "CURRENCY_NOT_SUPPORTED" };
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 1 || totalMinor > LIMITS.maxTotalMinor) return { code: "AMOUNT_INVALID" };
  return { facts: Object.freeze({ ref, checkIn, checkOut, nights, guests, totalMinor, currency }) };
}

/** the copy itself: plain text lines only; identical structure in both locales; the amount is the explicit USD form in both */
function lines(locale, f) {
  const usd = formatUsd(f.totalMinor);
  if (locale === "en") {
    return { subject: `Your ${BRAND} booking ${f.ref} is confirmed`,
      text: [`Your ${BRAND} booking ${f.ref} is confirmed.`, `Booking reference: ${f.ref}`, `Check-in: ${f.checkIn}`, `Check-out: ${f.checkOut}`,
        `Nights: ${f.nights}`, `Guests: ${f.guests}`, `Payment received: ${usd}`, "", BRAND].join("\n") };
  }
  return { subject: `Tu reservación de ${BRAND} ${f.ref} está confirmada`,
    text: [`Tu reservación de ${BRAND} ${f.ref} está confirmada.`, `Referencia de la reservación: ${f.ref}`, `Llegada (check-in): ${f.checkIn}`, `Salida (check-out): ${f.checkOut}`,
      `Noches: ${f.nights}`, `Huéspedes: ${f.guests}`, `Pago recibido: ${usd}`, "", BRAND].join("\n") };
}

/**
 * renderBookingConfirmation({ template, locale, facts }) → { ok:true, copy } | { ok:false, code }
 *   copy = frozen { contractVersion:"bcc-v1", template:"booking_confirmed", locale, subject, text } (plain text; deterministic for equal input)
 *   codes: INPUT_INVALID | TEMPLATE_INVALID | LOCALE_INVALID | FACTS_SHAPE | REF_INVALID | DATE_INVALID | DATE_ORDER_INVALID |
 *          NIGHTS_MISMATCH | GUESTS_INVALID | CURRENCY_NOT_SUPPORTED | AMOUNT_INVALID
 * Nothing is coerced or guessed; every refusal is code-only (no input echoed, no exception escapes the pure validation boundary).
 * Shape is checked on own property descriptors (exact key sets incl. hidden/symbol keys; enumerable data fields only; accessors refused
 * without invocation; hostile prototype/descriptor/Proxy traps → INPUT_INVALID / FACTS_SHAPE); validated values are snapshotted once.
 */
export function renderBookingConfirmation(input) {
  const x = extractExact(input, INPUT_KEYS, "INPUT_INVALID");
  if (x.code) return refuse(x.code);
  const { template, locale, facts } = x.values;
  if (!TEMPLATES.includes(template)) return refuse("TEMPLATE_INVALID");
  if (!LOCALES.includes(locale)) return refuse("LOCALE_INVALID");
  const v = validateFacts(facts);
  if (v.code) return refuse(v.code);
  const c = lines(locale, v.facts);
  return Object.freeze({ ok: true, copy: Object.freeze({ contractVersion: COPY_CONTRACT_VERSION, template, locale, subject: c.subject, text: c.text }) });
}
