// lib/checkout/booking-confirmation-request.js — Stage E7 guest notification: BOOKING-CONFIRMATION REQUEST BINDING "gn-v2" (C40). PURE:
// no I/O, no clock, no environment, no network, no database, no transport, no credentials.
//
// Binds the accepted bilingual copy (lib/checkout/booking-confirmation-copy.js, contract "bcc-v1") into ONE deterministic, email-shaped,
// deep-frozen request plus its content hash and the existing recipient hash. Request version "gn-v2": the nine gn-v1 REQUEST_KEYS plus
// `locale` and `copyContractVersion` (11 fields, all bound into the hash). The gn-v1 builder / hash vectors in guest-notification.js are
// untouched; this module imports only its exported helpers (RECIPIENT_RE, SENDER_NAME_RE, canonical, recipientHash, REQUEST_KEYS).
//
// NOT INTEGRATED and NOT SEND-ENABLED: the notification worker still builds gn-v1, and 0016 `notification_renders.template_version`
// CHECK = 'gn-v1' / `claim_guest_notification` still refuse "gn-v2" until a separately reviewed integration migration. The recipient and
// sender scope is the EXISTING `.invalid` test-address restriction (no relaxation). Rendering / hashing is NOT proof of payment, reservation
// confirmation or delivery; "facts" are TRUST input from reviewed state (the seven bcc-v1 facts, never the SQL v:1 envelope — a future
// worker maps the validated SQL snapshot explicitly). No greeting, links, HTML, CC/BCC, reply-to or any other unreviewed copy is added.
import { createHash } from "node:crypto";
import { RECIPIENT_RE, SENDER_NAME_RE, REQUEST_KEYS, canonical, recipientHash } from "./guest-notification.js";
import { renderBookingConfirmation, COPY_CONTRACT_VERSION, TEMPLATES, LOCALES } from "./booking-confirmation-copy.js";

export const REQUEST_VERSION = "gn-v2";
export const CONTENT_HASH_PREFIX = "gn-v2-content\n";
export const MESSAGE_REF_PREFIX = "gn2-";
export const INPUT_KEYS = Object.freeze(["facts", "guest", "locale", "opId", "sender", "template"]);
export const GUEST_KEYS = Object.freeze(["email", "firstName"]);
export const SENDER_KEYS = Object.freeze(["fromAddress", "fromName"]);
export const REQUEST_KEYS_V2 = Object.freeze([...REQUEST_KEYS, "copyContractVersion", "locale"].sort());
export { TEMPLATES, LOCALES, COPY_CONTRACT_VERSION };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;           // same grammar as the gn-v1 builder
const NAME_RE = /^[^\u0000-\u001f\u007f<>]{1,100}$/;                                            // mirrors gn-v1 NAME_RE (not exported there)
const isEmail = (e) => typeof e === "string" && e.length <= 254 && RECIPIENT_RE.test(e);     // existing bounds + `.invalid` scope
const refuse = (code) => Object.freeze({ ok: false, code });

/**
 * Descriptor-based EXACT-SHAPE extraction (accepted C37/C38 discipline): plain or null prototype; Reflect.ownKeys snapshotted once and
 * required to be exactly `keys` (length AND string membership — hidden / symbol keys are extras); each key an own ENUMERABLE DATA property
 * (accessors refused without invocation; [[Get]] never consulted); any thrown prototype / descriptor / Proxy trap → `code`. Returns a
 * one-time plain snapshot of the values, or { code }. Never echoes input.
 */
function extractExact(obj, keys, code) {
  try {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { code };
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return { code };
    const own = Reflect.ownKeys(obj);
    if (own.length !== keys.length) return { code };
    for (const k of own) if (typeof k !== "string" || !keys.includes(k)) return { code };
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

/** sha256 hex of UTF-8 'gn-v2-content\n' + canonical(request) — all 11 request fields bound (TRUST: stored by the DB, never re-derivable there) */
export const contentHashV2 = (request) => createHash("sha256").update(`${CONTENT_HASH_PREFIX}${canonical(request)}`, "utf8").digest("hex");

/**
 * buildBookingConfirmationRequest({ template, locale, facts, guest, sender, opId })
 *   → frozen { ok:true, request, contentHash, recipientHash } | frozen { ok:false, code }
 * request = deep-frozen, exactly REQUEST_KEYS_V2: channel "email", copyContractVersion "bcc-v1", from / fromName (sender), locale,
 * messageRef "gn2-<opId>", subject / text (bcc-v1 copy), template "booking_confirmed", templateVersion "gn-v2", to (guest.email ONLY).
 * Hashes are computed internally from the frozen snapshot; no caller-supplied hash / version / messageRef / request field is accepted
 * (any extra outer key is INPUT_INVALID).
 * codes: INPUT_INVALID | OP_ID_INVALID | (bcc-v1 renderer codes: TEMPLATE_INVALID | LOCALE_INVALID | FACTS_SHAPE | REF_INVALID | DATE_INVALID |
 *        DATE_ORDER_INVALID | NIGHTS_MISMATCH | GUESTS_INVALID | CURRENCY_NOT_SUPPORTED | AMOUNT_INVALID) | RECIPIENT_INVALID | SENDER_INVALID
 */
export function buildBookingConfirmationRequest(input) {
  const x = extractExact(input, INPUT_KEYS, "INPUT_INVALID");
  if (x.code) return refuse(x.code);
  const { template, locale, facts, guest, sender, opId } = x.values;
  if (typeof opId !== "string" || !UUID_RE.test(opId)) return refuse("OP_ID_INVALID");
  // the renderer performs its own descriptor-based extraction and full validation of template / locale / facts (no weaker pre-read here)
  const r = renderBookingConfirmation({ template, locale, facts });
  if (!r.ok) return refuse(r.code);
  const g = extractExact(guest, GUEST_KEYS, "RECIPIENT_INVALID");
  if (g.code || !isEmail(g.values.email) || typeof g.values.firstName !== "string" || !NAME_RE.test(g.values.firstName)) return refuse("RECIPIENT_INVALID");
  const s = extractExact(sender, SENDER_KEYS, "SENDER_INVALID");
  if (s.code || !isEmail(s.values.fromAddress) || typeof s.values.fromName !== "string" || !SENDER_NAME_RE.test(s.values.fromName)) return refuse("SENDER_INVALID");
  const request = Object.freeze({ channel: "email", copyContractVersion: r.copy.contractVersion, from: s.values.fromAddress, fromName: s.values.fromName,
    locale: r.copy.locale, messageRef: `${MESSAGE_REF_PREFIX}${opId}`, subject: r.copy.subject, template: r.copy.template, templateVersion: REQUEST_VERSION,
    text: r.copy.text, to: g.values.email });
  return Object.freeze({ ok: true, request, contentHash: contentHashV2(request), recipientHash: recipientHash(g.values.email, g.values.firstName) });
}
