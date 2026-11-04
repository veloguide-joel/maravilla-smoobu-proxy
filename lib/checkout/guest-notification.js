// lib/checkout/guest-notification.js — Stage E7 guest notification STAGE 2 (OFFLINE / INJECTED MOCK). PURE: no I/O, no clock, no
// network, no environment. Contract: claude/e7-guest-notification-contract.md revision 3 (§3, §6.4 as corrected by §15.9).
//
// Builds the ONE frozen email-shaped request for a notification from the SQL facts object and the bound guest row, computes its
// canonical content hash (a TRUST field the database stores but cannot validate), and classifies an injected executor's reply.
// The copy is ENGLISH MOCK COPY for offline tests only (root D3): final wording / language / sender / recipient policy are owner
// decisions that remain CLOSED. `.invalid` addresses and `mock-` ids are TEST-ADDRESS / correlation restrictions, NOT transport
// authentication and NOT proof that an injected executor is a mock. "accepted" means "the injected executor said accepted" — never
// delivered or read. No links, tokens, access instructions, attachments, HTML, CC / BCC or reply-to: there is nothing to override.
import { createHash } from "node:crypto";

export const TEMPLATE_VERSION = "gn-v1";
export const TEMPLATES = Object.freeze(["booking_confirmed", "not_charged_authorization_may_show", "not_completed_not_charged"]);
export const REQUEST_KEYS = Object.freeze(["channel", "from", "fromName", "messageRef", "subject", "template", "templateVersion", "text", "to"]);
export const RECIPIENT_RE = /^[a-z0-9._+-]{1,64}@([a-z0-9-]{1,63}\.)+invalid$/;
export const SENDER_NAME_RE = /^[A-Za-z0-9 .'-]{1,64}$/;
export const MOCK_MESSAGE_ID_RE = /^mock-[A-Za-z0-9._:-]{1,95}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^MV-[A-Z0-9]{6,10}$/;
const NAME_RE = /^[^\u0000-\u001f\u007f<>]{1,100}$/;

const isPlain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));
const refuse = (code) => Object.freeze({ ok: false, code });
const isEmail = (e) => typeof e === "string" && e.length <= 254 && RECIPIENT_RE.test(e);

/** integer minor units (USD) → "$1,234.56 USD"; null for anything else */
export function formatUsd(minor) {
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  const whole = String(Math.floor(minor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${String(minor % 100).padStart(2, "0")} USD`;
}

/** validated, copied facts (only the fields the copy uses) or null */
function factsFor(facts, template) {
  if (!isPlain(facts)) return null;
  const f = { template: facts.template, ref: facts.ref, checkIn: facts.checkIn, checkOut: facts.checkOut, nights: facts.nights, guests: facts.guests,
    totalMinor: facts.totalMinor, currency: facts.currency };
  if (f.template !== template || typeof f.ref !== "string" || !REF_RE.test(f.ref) || typeof f.checkIn !== "string" || !DATE_RE.test(f.checkIn)
      || typeof f.checkOut !== "string" || !DATE_RE.test(f.checkOut) || !(f.checkIn < f.checkOut) || !Number.isSafeInteger(f.nights) || f.nights < 1 || f.nights > 365
      || !Number.isSafeInteger(f.guests) || f.guests < 1 || f.guests > 50 || !Number.isSafeInteger(f.totalMinor) || f.totalMinor <= 0) return null;
  return f;
}

const PENDING = "Some banks may still show the temporary authorization as pending for a few days until it disappears; it is not a charge.";
/** ENGLISH MOCK COPY (offline tests only; owner-reviewable). Plain text. */
function copy(template, f, firstName) {
  const hello = `Hello ${firstName},`;
  if (template === "booking_confirmed") {
    return { subject: `Your maraVilla booking ${f.ref} is confirmed`,
      text: [hello, "", `Your maraVilla booking ${f.ref} is confirmed.`, `Check-in: ${f.checkIn}`, `Check-out: ${f.checkOut}`, `Nights: ${f.nights}`, `Guests: ${f.guests}`, "",
        `We have charged ${formatUsd(f.totalMinor)} to your card.`, "", "maraVilla"].join("\n") };
  }
  if (template === "not_charged_authorization_may_show") {
    return { subject: `Your maraVilla booking ${f.ref} could not be completed — you were not charged`,
      text: [hello, "", `We could not complete your maraVilla booking ${f.ref} (${f.checkIn} to ${f.checkOut}), and you were not charged.`,
        "We have released the temporary authorization on your card.", PENDING, "", "maraVilla"].join("\n") };
  }
  return { subject: `Your maraVilla booking ${f.ref} was not completed — you were not charged`,
    text: [hello, "", `We could not complete your maraVilla booking ${f.ref} (${f.checkIn} to ${f.checkOut}); the reservation has been cancelled and you were not charged.`,
      PENDING, "", "maraVilla"].join("\n") };
}

/**
 * buildMessageRequest({ template, facts, guest, sender, opId }) → { ok:true, request } | { ok:false, code }.
 * codes: TEMPLATE_INVALID | RENDER_FACTS_INVALID | CURRENCY_NOT_SUPPORTED | RECIPIENT_INVALID | SENDER_INVALID | OP_ID_INVALID.
 * The recipient is ALWAYS the bound guest row's email (no override exists); the request is deep-frozen with exactly REQUEST_KEYS.
 */
export function buildMessageRequest({ template, facts, guest, sender, opId } = {}) {
  if (!TEMPLATES.includes(template)) return refuse("TEMPLATE_INVALID");
  if (typeof opId !== "string" || !UUID_RE.test(opId)) return refuse("OP_ID_INVALID");
  const f = factsFor(facts, template);
  if (!f) return refuse("RENDER_FACTS_INVALID");
  if (f.currency !== "USD" || !formatUsd(f.totalMinor)) return refuse("CURRENCY_NOT_SUPPORTED");
  if (!isPlain(guest) || !isEmail(guest.email) || typeof guest.firstName !== "string" || !NAME_RE.test(guest.firstName)) return refuse("RECIPIENT_INVALID");
  if (!isPlain(sender) || JSON.stringify(Object.keys(sender).sort()) !== '["fromAddress","fromName"]' || !isEmail(sender.fromAddress)
      || typeof sender.fromName !== "string" || !SENDER_NAME_RE.test(sender.fromName)) return refuse("SENDER_INVALID");
  const c = copy(template, f, guest.firstName);
  const request = Object.freeze({ channel: "email", from: sender.fromAddress, fromName: sender.fromName, messageRef: `gn1-${opId}`, subject: c.subject,
    template, templateVersion: TEMPLATE_VERSION, text: c.text, to: guest.email });
  return Object.freeze({ ok: true, request });
}

/** canonical JSON of a request: keys sorted by code unit, no whitespace, strings / safe integers only (anything else is a programming error) */
export function canonical(request) {
  if (!isPlain(request)) throw new TypeError("canonical: plain object required");
  const keys = Object.keys(request).sort();
  return `{${keys.map((k) => {
    const v = request[k];
    if (!(typeof v === "string" || Number.isSafeInteger(v))) throw new TypeError("canonical: strings and safe integers only");
    return `${JSON.stringify(k)}:${JSON.stringify(v)}`;
  }).join(",")}}`;
}

/** sha256 hex of UTF-8 'gn-v1-content\n' + canonical(request) (TRUST: stored by the DB, never re-derivable there) */
export const contentHash = (request) => createHash("sha256").update(`gn-v1-content\n${canonical(request)}`, "utf8").digest("hex");

/** SQL recipient-hash mirror (pseudonymous; used only to cross-check the observation is self-consistent) */
export const recipientHash = (email, firstName) => createHash("sha256").update(`gn-v1-recipient\n${email}\n${firstName}`, "utf8").digest("hex");

/**
 * classifyReply(reply) → { kind:'accepted', providerMessageId } only for EXACTLY { accepted: true, providerMessageId: <mock id> } with a plain
 * prototype and data properties; otherwise { kind:'unknown', code: 'REPLY_SHAPE' | 'REPLY_UNREADABLE' }. Never throws; never reads beyond
 * these two own properties; the reply is never persisted or returned.
 */
export function classifyReply(reply) {
  try {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) return Object.freeze({ kind: "unknown", code: "REPLY_SHAPE" });
    const proto = Object.getPrototypeOf(reply);
    if (proto !== Object.prototype && proto !== null) return Object.freeze({ kind: "unknown", code: "REPLY_SHAPE" });
    const d = Object.getOwnPropertyDescriptors(reply);
    const keys = Reflect.ownKeys(d);
    if (keys.length !== 2 || !keys.includes("accepted") || !keys.includes("providerMessageId")) return Object.freeze({ kind: "unknown", code: "REPLY_SHAPE" });
    for (const k of keys) if (!("value" in d[k]) || !d[k].enumerable) return Object.freeze({ kind: "unknown", code: "REPLY_SHAPE" });
    const id = d.providerMessageId.value;
    if (d.accepted.value !== true || typeof id !== "string" || !MOCK_MESSAGE_ID_RE.test(id)) return Object.freeze({ kind: "unknown", code: "REPLY_SHAPE" });
    return Object.freeze({ kind: "accepted", providerMessageId: id });
  } catch {
    return Object.freeze({ kind: "unknown", code: "REPLY_UNREADABLE" });
  }
}
