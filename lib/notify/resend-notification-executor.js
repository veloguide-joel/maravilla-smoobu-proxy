// lib/notify/resend-notification-executor.js — C45: the gn-v2 → Resend PROVIDER EXECUTOR (OFFLINE integration; no I/O of its own).
//
// createResendNotificationExecutor({ exchange, credential, sender }) → { ok:true, executor } | { ok:false, code }. The executor maps the worker's
// internally built, frozen gn-v2 booking-confirmation request (lib/checkout/booking-confirmation-request.js) to the EXACT Resend wire fields
//   {"from": "<fromName> <<from>>", "to": [<to>], "subject": <subject>, "text": <text>}
// WITHOUT rewriting recipient, sender, locale, subject or text, and performs AT MOST ONE injected exchange call, ever (single-use).
//   * NOTHING is accepted from the caller but { request, opId, contentHash }: the content hash is RECOMPUTED here (contentHashV2) and must equal
//     the one passed (the worker passes its builder hash, which the SQL pre-send also matched against the stored render); messageRef must be
//     'gn2-<opId>'; the request must be the exact 11-key gn-v2 shape of own enumerable DATA properties (no accessor is invoked).
//   * The SENDER is bound at construction and must equal request.from / request.fromName. The RECIPIENT stays inside the EXISTING scope —
//     `.invalid` test addresses only (RECIPIENT_RE, the same fence as the builder / worker / 0016 SQL). This module does NOT choose a sending
//     domain and does NOT relax the recipient policy; a verified sender and a bounded real-recipient policy are later, ROOT-reviewed steps.
//   * No cc / bcc / reply_to / html / attachments / tags / headers / scheduling / template field can be produced: the wire object has exactly
//     the four keys above. The route is the reviewed fixed POST https://api.resend.com/emails (scripts/e7-resend/resend-exchange.mjs, copied
//     byte-identically from main #111; the exchange itself is INJECTED, so tests use fakes and production wiring is a separate reviewed step).
//   * Provider Idempotency-Key = 'mv-gn2-resend-v1/<opId>/<contentHash>' (≤ 256): stable per operation + content. The provider keeps it ~24 h;
//     that window is NOT a retry license and does NOT replace the durable no-resend rule (one claim, one invocation, never retried).
//   * Reply: success ONLY for HTTP 200 + JSON exactly {"id": <lowercase UUID>} → { kind:"accepted", provider:"resend", providerMessageId,
//     replayed } where replayed is the documented `idempotent-replayed: true` header; everything else → { kind:"unknown", code } (code-only).
//     A refusal BEFORE the exchange (shape / hash / binding / key / spent) → { kind:"refused", code } with the exchange NOT called.
//   * The key comes from the injected credential() at send time only; it, the Authorization header, addresses, subject, body, provider
//     text and exception messages are never returned or logged.
import { createHash } from "node:crypto";
import { RECIPIENT_RE, SENDER_NAME_RE, isRecipientInScopeFor } from "../checkout/guest-notification.js";
import { contentHashV2, REQUEST_KEYS_V2, REQUEST_VERSION, MESSAGE_REF_PREFIX, COPY_CONTRACT_VERSION } from "../checkout/booking-confirmation-request.js";
import { isApprovedRealSender } from "./sender-identity.js";   // C54: sender only; the `.invalid` recipient scope in prepare() is unchanged

const freeze = Object.freeze;
export const RESEND_EXECUTOR_PROTOCOL = "resend-gn2-v1";
export const RESEND_HOST = "api.resend.com";
export const RESEND_PATH = "/emails";
export const RESEND_METHOD = "POST";
export const RESEND_USER_AGENT = "maravilla-e7-notification-resend/1";
export const IDEMPOTENCY_PREFIX = "mv-gn2-resend-v1/";
export const WIRE_KEYS = freeze(["from", "to", "subject", "text"]);
export const HEADER_NAMES = freeze(["Authorization", "Content-Type", "Content-Length", "User-Agent", "Idempotency-Key", "Accept", "Accept-Encoding"]);
/** code-only outcomes of ONE exchange (persisted as the operation's error_code; all are UNKNOWN — never retried) */
export const RESEND_UNKNOWN_CODES = freeze(["HTTP_STATUS", "REPLY_CONTENT_TYPE", "REPLY_JSON_INVALID", "REPLY_SHAPE", "REPLY_ID_INVALID", "REPLAY_HEADER_INVALID",
  "EXCHANGE_DEADLINE", "EXCHANGE_NETWORK_ERROR", "EXCHANGE_PREMATURE_CLOSE", "EXCHANGE_STATUS_INVALID", "EXCHANGE_ENCODING_REFUSED", "EXCHANGE_BODY_TOO_LARGE",
  "EXCHANGE_SETUP_FAILED", "EXCHANGE_SPENT", "EXCHANGE_INPUT_INVALID", "EXCHANGE_UNKNOWN"]);
/** refusals BEFORE any exchange call */
export const RESEND_REFUSAL_CODES = freeze(["EXECUTOR_SPENT", "INPUT_INVALID", "REQUEST_SHAPE", "REQUEST_VERSION", "OP_REF_MISMATCH", "CONTENT_HASH_MISMATCH",
  "SENDER_BINDING", "RECIPIENT_SCOPE", "CONTENT_INVALID", "KEY_INVALID"]);

const BRAND = new WeakSet();
/** true only for an executor created by createResendNotificationExecutor (no look-alike object / arbitrary provider seam) */
export const isResendNotificationExecutor = (x) => (typeof x === "object" || typeof x === "function") && x !== null && BRAND.has(x);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_RE = /^re_[\x21-\x7E]{8,256}$/;
const isEmail = (e) => typeof e === "string" && e.length <= 254 && RECIPIENT_RE.test(e);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** exact own-enumerable-DATA extraction (Reflect.ownKeys length + string membership); null when the object does not qualify; never invokes accessors */
function exact(obj, keys) {
  try {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    const p = Object.getPrototypeOf(obj); if (p !== Object.prototype && p !== null) return null;
    const own = Reflect.ownKeys(obj);
    if (own.length !== keys.length) return null;
    for (const k of own) if (typeof k !== "string" || !keys.includes(k)) return null;
    const out = {};
    for (const k of keys) { const d = Object.getOwnPropertyDescriptor(obj, k); if (!d || d.enumerable !== true || !Object.hasOwn(d, "value")) return null; out[k] = d.value; }
    return out;
  } catch { return null; }
}

/** classify the ONE reply (allowlisted fields only; nothing from the provider body is ever copied but the UUID) */
export function classifyResendReply(reply) {
  if (reply === null || typeof reply !== "object" || !Number.isSafeInteger(reply.status)) return freeze({ kind: "unknown", code: "REPLY_SHAPE" });
  if (reply.status !== 200) return freeze({ kind: "unknown", code: "HTTP_STATUS", httpStatus: reply.status });
  const ct = reply.headers?.contentType;
  if (typeof ct !== "string" || !/^application\/json(\s*;\s*charset=utf-8)?$/i.test(ct.trim())) return freeze({ kind: "unknown", code: "REPLY_CONTENT_TYPE" });
  let j; try { j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(reply.body)); } catch { return freeze({ kind: "unknown", code: "REPLY_JSON_INVALID" }); }
  if (j === null || typeof j !== "object" || Array.isArray(j) || JSON.stringify(Object.keys(j)) !== '["id"]') return freeze({ kind: "unknown", code: "REPLY_SHAPE" });
  if (typeof j.id !== "string" || !UUID_RE.test(j.id)) return freeze({ kind: "unknown", code: "REPLY_ID_INVALID" });
  const rp = reply.headers?.idempotentReplayed;
  if (rp !== null && rp !== undefined && rp !== "true" && rp !== "false") return freeze({ kind: "unknown", code: "REPLAY_HEADER_INVALID" });
  return freeze({ kind: "accepted", provider: "resend", providerMessageId: j.id, replayed: rp === "true" });
}

export function createResendNotificationExecutor(input) {
  // P2d: optional own key `mode` ("test" default, "live"): selects the recipient scope only. Absent = exactly the accepted TEST executor.
  const hasMode = input !== null && typeof input === "object" && Object.hasOwn(input, "mode");
  const o = exact(input, hasMode ? ["credential", "exchange", "mode", "sender"] : ["credential", "exchange", "sender"]);
  if (o && hasMode && o.mode !== "test" && o.mode !== "live") return freeze({ ok: false, code: "EXECUTOR_OPTIONS_INVALID" });
  const mode = o && hasMode ? o.mode : "test";
  if (!o || typeof o.exchange !== "function" || typeof o.credential !== "function") return freeze({ ok: false, code: "EXECUTOR_OPTIONS_INVALID" });
  const s = exact(o.sender, ["fromAddress", "fromName"]);
  if (!s || !((isEmail(s.fromAddress) && typeof s.fromName === "string" && SENDER_NAME_RE.test(s.fromName)) || isApprovedRealSender(s.fromAddress, s.fromName))) return freeze({ ok: false, code: "EXECUTOR_SENDER_INVALID" });
  const sender = freeze({ fromAddress: s.fromAddress, fromName: s.fromName });
  const exchange = o.exchange; const credential = o.credential;
  let spent = false;

  /** pure validation + wire plan (no credential, no exchange); { ok:true, plan } | { ok:false, code } */
  function prepare(arg) {
    const a = exact(arg, ["contentHash", "opId", "request"]);
    if (!a) return freeze({ ok: false, code: "INPUT_INVALID" });
    if (typeof a.opId !== "string" || !UUID_RE.test(a.opId) || typeof a.contentHash !== "string" || !HEX64.test(a.contentHash)) return freeze({ ok: false, code: "INPUT_INVALID" });
    let frozen; try { frozen = Object.isFrozen(a.request); } catch { frozen = false; }        // a hostile Proxy trap is a shape refusal, never a throw
    if (!frozen) return freeze({ ok: false, code: "REQUEST_SHAPE" });
    const r = exact(a.request, [...REQUEST_KEYS_V2]);
    if (!r || Object.values(r).some((v) => typeof v !== "string")) return freeze({ ok: false, code: "REQUEST_SHAPE" });
    if (r.templateVersion !== REQUEST_VERSION || r.copyContractVersion !== COPY_CONTRACT_VERSION || r.template !== "booking_confirmed" || r.channel !== "email"
        || !["en", "es"].includes(r.locale)) return freeze({ ok: false, code: "REQUEST_VERSION" });
    if (r.messageRef !== `${MESSAGE_REF_PREFIX}${a.opId}`) return freeze({ ok: false, code: "OP_REF_MISMATCH" });
    if (contentHashV2(r) !== a.contentHash) return freeze({ ok: false, code: "CONTENT_HASH_MISMATCH" });
    if (r.from !== sender.fromAddress || r.fromName !== sender.fromName) return freeze({ ok: false, code: "SENDER_BINDING" });
    if (!isRecipientInScopeFor(r.to, mode)) return freeze({ ok: false, code: "RECIPIENT_SCOPE" });   // C116: `.invalid` OR exactly the sink (recipient only)
    if (r.subject.length < 1 || r.subject.length > 200 || /[\r\n\u0000-\u001f\u007f]/.test(r.subject) || r.text.length < 1 || r.text.length > 10000 || /[\r\u0000-\u0009\u000b-\u001f\u007f]/.test(r.text)) {
      return freeze({ ok: false, code: "CONTENT_INVALID" });
    }
    const body = Buffer.from(JSON.stringify({ from: `${r.fromName} <${r.from}>`, to: [r.to], subject: r.subject, text: r.text }), "utf8");
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${a.opId}/${a.contentHash}`;
    return freeze({ ok: true, plan: freeze({ body, bodyHash: sha256(body), idempotencyKey, contentLength: String(body.length) }) });
  }

  /** the ONE send: refusals settle synchronously WITHOUT the exchange; otherwise the exchange is called synchronously (no await before it) */
  function send(arg) {
    if (spent) return Promise.resolve(freeze({ kind: "refused", code: "EXECUTOR_SPENT" }));
    spent = true;
    const p = prepare(arg);
    if (!p.ok) return Promise.resolve(freeze({ kind: "refused", code: p.code }));
    let token; try { token = credential(); } catch { token = null; }
    if (typeof token !== "string" || !KEY_RE.test(token)) return Promise.resolve(freeze({ kind: "refused", code: "KEY_INVALID" }));
    const req = { method: RESEND_METHOD, host: RESEND_HOST, path: RESEND_PATH, body: p.plan.body,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": p.plan.contentLength, "User-Agent": RESEND_USER_AGENT,
        "Idempotency-Key": p.plan.idempotencyKey, Accept: "application/json", "Accept-Encoding": "identity" } };
    token = null;
    let pending;
    try { pending = Promise.resolve(exchange(req)); } catch (e) { pending = Promise.reject(e); }
    return pending.then((reply) => classifyResendReply(reply), (e) => {
      const c = e && typeof e === "object" && typeof e.code === "string" && RESEND_UNKNOWN_CODES.includes(e.code) ? e.code : "EXCHANGE_UNKNOWN";
      return freeze({ kind: "unknown", code: c });
    });
  }

  const executor = freeze({ protocol: RESEND_EXECUTOR_PROTOCOL, sender, prepare, send, isSpent: () => spent });
  BRAND.add(executor);
  return freeze({ ok: true, executor });
}
